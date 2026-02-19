/**
 * ESC/POS Thermal Receipt Printer Module
 *
 * Uses raw device file (/dev/usb/lp0) for printing.
 * Graceful failure: if printer is not connected, operations log a warning
 * but never crash the server.
 */

const fs = require('fs');

// ESC/POS command constants
const ESC = 0x1b;
const GS = 0x1d;
const COMMANDS = {
  INIT: Buffer.from([ESC, 0x40]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  DOUBLE_SIZE: Buffer.from([GS, 0x21, 0x11]),
  DOUBLE_HEIGHT: Buffer.from([GS, 0x21, 0x01]),
  NORMAL_SIZE: Buffer.from([GS, 0x21, 0x00]),
  CUT: Buffer.from([GS, 0x56, 0x00]),
  FEED_3: Buffer.from([ESC, 0x64, 0x03]),
  LINE: Buffer.from('================================\n'),
};

function isPrinterAvailable() {
  const device = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
  try {
    fs.accessSync(device, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function writeToPrinter(buffers) {
  const device = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
  const data = Buffer.concat(buffers);
  fs.writeFileSync(device, data);
}

function textBuf(str) {
  return Buffer.from(str + '\n', 'utf8');
}

function formatPrice(cents) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function formatDateTime(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return d.toLocaleString('nl-NL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Print a customer receipt (after payment)
 */
function printReceipt(order, shopName) {
  try {
    if (!isPrinterAvailable()) {
      console.warn('Printer niet beschikbaar — bon wordt overgeslagen');
      return;
    }

    const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    const paymentLabels = { pin: 'PIN', cash: 'Contant', online: 'Online' };

    const buffers = [
      COMMANDS.INIT,
      COMMANDS.ALIGN_CENTER,
      COMMANDS.BOLD_ON,
      COMMANDS.DOUBLE_SIZE,
      textBuf(shopName),
      COMMANDS.NORMAL_SIZE,
      COMMANDS.BOLD_OFF,
      textBuf(''),
      textBuf(formatDateTime(order.created_at)),
      textBuf(`Bestelling #${order.order_number}`),
      COMMANDS.LINE,
      COMMANDS.ALIGN_LEFT,
    ];

    for (const item of items) {
      const lineTotal = item.price * item.quantity;
      const left = `${item.quantity}x ${item.name}`;
      const right = `EUR ${formatPrice(lineTotal)}`;
      const padding = Math.max(1, 32 - left.length - right.length);
      buffers.push(textBuf(left + ' '.repeat(padding) + right));
      // Print extensions
      if (item.extensions) {
        for (const ext of item.extensions) {
          for (const choice of (ext.items || [])) {
            const extLeft = `  + ${choice.name}`;
            if (ext.type === 'item' && choice.price) {
              const extRight = `+${formatPrice(choice.price)}`;
              const extPad = Math.max(1, 32 - extLeft.length - extRight.length);
              buffers.push(textBuf(extLeft + ' '.repeat(extPad) + extRight));
            } else {
              buffers.push(textBuf(extLeft));
            }
          }
        }
      }
      // Print note
      if (item.note) {
        buffers.push(textBuf(`  "${item.note}"`));
      }
    }

    buffers.push(
      COMMANDS.LINE,
      COMMANDS.ALIGN_CENTER,
      COMMANDS.BOLD_ON,
      COMMANDS.DOUBLE_HEIGHT,
      textBuf(`TOTAAL: EUR ${formatPrice(order.total)}`),
      COMMANDS.NORMAL_SIZE,
      COMMANDS.BOLD_OFF,
      textBuf(''),
      textBuf(`Betaald: ${paymentLabels[order.payment_method] || order.payment_method}`),
      textBuf(''),
      textBuf('Bedankt voor uw bestelling!'),
      COMMANDS.FEED_3,
      COMMANDS.CUT,
    );

    writeToPrinter(buffers);
  } catch (err) {
    console.error('Fout bij printen bon:', err.message);
  }
}

/**
 * Print a kitchen ticket (for order preparation)
 */
function printKitchenTicket(order, shopName) {
  try {
    if (!isPrinterAvailable()) {
      console.warn('Printer niet beschikbaar — keukenbon wordt overgeslagen');
      return;
    }

    const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    const originLabel = order.origin === 'qr' ? 'QR BESTELLING' : 'KASSA';

    const buffers = [
      COMMANDS.INIT,
      COMMANDS.ALIGN_CENTER,
      COMMANDS.BOLD_ON,
      COMMANDS.DOUBLE_SIZE,
      textBuf(`#${order.order_number}`),
      COMMANDS.NORMAL_SIZE,
      textBuf(''),
      textBuf(originLabel),
    ];

    if (order.customer_name) {
      buffers.push(textBuf(order.customer_name));
    }

    buffers.push(
      textBuf(''),
      COMMANDS.LINE,
      COMMANDS.ALIGN_LEFT,
      COMMANDS.DOUBLE_HEIGHT,
    );

    for (const item of items) {
      buffers.push(textBuf(`  ${item.quantity}x ${item.name}`));
      // Print extensions
      if (item.extensions) {
        for (const ext of item.extensions) {
          for (const choice of (ext.items || [])) {
            buffers.push(COMMANDS.NORMAL_SIZE);
            buffers.push(textBuf(`    + ${choice.name}`));
            buffers.push(COMMANDS.DOUBLE_HEIGHT);
          }
        }
      }
      // Print note
      if (item.note) {
        buffers.push(COMMANDS.NORMAL_SIZE);
        buffers.push(textBuf(`    "${item.note}"`));
        buffers.push(COMMANDS.DOUBLE_HEIGHT);
      }
    }

    buffers.push(
      COMMANDS.NORMAL_SIZE,
      COMMANDS.LINE,
      COMMANDS.ALIGN_CENTER,
      COMMANDS.BOLD_OFF,
      textBuf(formatDateTime(order.created_at)),
      COMMANDS.FEED_3,
      COMMANDS.CUT,
    );

    writeToPrinter(buffers);
  } catch (err) {
    console.error('Fout bij printen keukenbon:', err.message);
  }
}

/**
 * Print a test receipt to verify printer works
 */
function printTestReceipt(shopName) {
  try {
    if (!isPrinterAvailable()) {
      return { success: false, error: 'Printer niet gevonden. Controleer de USB-verbinding en PRINTER_DEVICE in .env' };
    }

    const buffers = [
      COMMANDS.INIT,
      COMMANDS.ALIGN_CENTER,
      COMMANDS.BOLD_ON,
      COMMANDS.DOUBLE_SIZE,
      textBuf(shopName),
      COMMANDS.NORMAL_SIZE,
      COMMANDS.BOLD_OFF,
      textBuf(''),
      textBuf('=== TEST PRINT ==='),
      textBuf(''),
      textBuf(formatDateTime()),
      textBuf(''),
      textBuf('Printer werkt correct!'),
      COMMANDS.FEED_3,
      COMMANDS.CUT,
    ];

    writeToPrinter(buffers);
    return { success: true };
  } catch (err) {
    console.error('Fout bij test print:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Print a QR code linking to the ordering page
 * Note: QR code on receipt uses ESC/POS QR commands
 */
function printQRCode(url, shopName) {
  try {
    if (!isPrinterAvailable()) {
      return { success: false, error: 'Printer niet gevonden' };
    }

    const urlBytes = Buffer.from(url, 'utf8');
    const storeLen = urlBytes.length + 3;
    const pL = storeLen % 256;
    const pH = Math.floor(storeLen / 256);

    const buffers = [
      COMMANDS.INIT,
      COMMANDS.ALIGN_CENTER,
      COMMANDS.BOLD_ON,
      COMMANDS.DOUBLE_SIZE,
      textBuf(shopName),
      COMMANDS.NORMAL_SIZE,
      COMMANDS.BOLD_OFF,
      textBuf(''),
      textBuf('Scan om te bestellen:'),
      textBuf(''),
      // QR Code: set model
      Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
      // QR Code: set size (8 = large)
      Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x08]),
      // QR Code: set error correction (L)
      Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30]),
      // QR Code: store data
      Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
      urlBytes,
      // QR Code: print
      Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
      textBuf(''),
      textBuf(url),
      COMMANDS.FEED_3,
      COMMANDS.CUT,
    ];

    writeToPrinter(buffers);
    return { success: true };
  } catch (err) {
    console.error('Fout bij printen QR code:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  printReceipt,
  printKitchenTicket,
  printTestReceipt,
  printQRCode,
  isPrinterAvailable,
};
