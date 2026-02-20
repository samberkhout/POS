/**
 * Adyen Checkout API Module (Online betaling via QR)
 *
 * Creates payment sessions for the customer ordering page.
 * Verifies webhook HMAC signatures for payment confirmations.
 */

const crypto = require('crypto');

const ENDPOINTS = {
  test: 'https://checkout-test.adyen.com/v71',
  live: 'https://checkout-live.adyen.com/v71',
};

/**
 * Create a checkout session for online payment
 * @param {number} amountCents - Amount in cents
 * @param {string} orderReference - Unique order reference
 * @param {number} orderId - Database order ID (used in return URL)
 * @returns {Promise<{sessionId: string, sessionData: string}>}
 */
async function createCheckoutSession(amountCents, orderReference, orderId) {
  const apiKey = process.env.ADYEN_CHECKOUT_API_KEY || process.env.ADYEN_API_KEY;
  const merchantAccount = process.env.ADYEN_MERCHANT_ACCOUNT;
  const environment = process.env.ADYEN_ENVIRONMENT || 'test';
  const endpoint = ENDPOINTS[environment] || ENDPOINTS.test;
  const publicUrl = process.env.PUBLIC_URL || 'https://bestel.jouwdomein.nl';

  const payload = {
    merchantAccount: merchantAccount,
    amount: {
      currency: 'EUR',
      value: amountCents,
    },
    reference: orderReference,
    returnUrl: `${publicUrl}/bedankt.html?orderid=${orderId}`,
    countryCode: 'NL',
    channel: 'Web',
    shopperLocale: 'nl-NL',
    allowedPaymentMethods: ['ideal'],
  };

  const response = await fetch(`${endpoint}/sessions`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Adyen Checkout fout:', response.status, text);
    throw new Error(`Adyen Checkout fout: ${response.status}`);
  }

  const data = await response.json();

  return {
    sessionId: data.id,
    sessionData: data.sessionData,
  };
}

/**
 * Verify Adyen webhook HMAC signature
 * @param {object} notificationItem - The NotificationRequestItem from webhook
 * @returns {boolean}
 */
function verifyWebhookHmac(notificationItem) {
  const hmacKey = process.env.ADYEN_WEBHOOK_HMAC_KEY;
  if (!hmacKey) {
    console.warn('ADYEN_WEBHOOK_HMAC_KEY niet geconfigureerd — HMAC verificatie overgeslagen');
    return true;
  }

  try {
    const data = notificationItem;
    const payload = [
      data.pspReference || '',
      data.originalReference || '',
      data.merchantAccountCode || '',
      data.merchantReference || '',
      data.amount?.value?.toString() || '',
      data.amount?.currency || '',
      data.eventCode || '',
      data.success || '',
    ].join(':');

    const keyBuffer = Buffer.from(hmacKey, 'hex');
    const calculated = crypto
      .createHmac('sha256', keyBuffer)
      .update(payload, 'utf8')
      .digest('base64');

    const received = data.additionalData?.hmacSignature;
    if (!received) {
      console.warn('Geen HMAC signature in webhook notificatie');
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(calculated, 'base64'),
      Buffer.from(received, 'base64')
    );
  } catch (err) {
    console.error('HMAC verificatie fout:', err.message);
    return false;
  }
}

/**
 * Get the Adyen client key for Drop-in component
 */
function getClientKey() {
  return process.env.ADYEN_CHECKOUT_CLIENT_KEY || '';
}

/**
 * Get the Adyen environment for Drop-in component
 */
function getEnvironment() {
  return process.env.ADYEN_ENVIRONMENT || 'test';
}

module.exports = {
  createCheckoutSession,
  verifyWebhookHmac,
  getClientKey,
  getEnvironment,
};
