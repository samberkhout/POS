/**
 * Adyen Terminal API Module (Pin betaling)
 *
 * Uses the cloud endpoint for synchronous terminal payments.
 * The Verifone P630 terminal must have a 4G SIM connection to Adyen.
 */

const { v4: uuidv4 } = require('uuid');

const ENDPOINTS = {
  test: 'https://terminal-api-test.adyen.com/sync',
  live: 'https://terminal-api-live.adyen.com/sync',
};

// Track active payment for cancellation
let activePayment = null;

/**
 * Initiate a pin payment on the Adyen terminal
 * @param {number} amountCents - Amount in cents (e.g., 1250 = EUR 12,50)
 * @param {string} orderReference - Unique order reference
 * @returns {Promise<{success: boolean, reference?: string, error?: string}>}
 */
async function initiatePayment(amountCents, orderReference) {
  const apiKey = process.env.ADYEN_API_KEY;
  const poiid = process.env.ADYEN_POIID;
  const merchantAccount = process.env.ADYEN_MERCHANT_ACCOUNT;
  const environment = process.env.ADYEN_ENVIRONMENT || 'test';
  const endpoint = ENDPOINTS[environment] || ENDPOINTS.test;

  const serviceId = uuidv4().substring(0, 10);
  activePayment = { serviceId, poiid };

  const payload = {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0',
        MessageClass: 'Service',
        MessageCategory: 'Payment',
        MessageType: 'Request',
        ServiceID: serviceId,
        SaleID: 'POSSystem',
        POIID: poiid,
      },
      PaymentRequest: {
        SaleData: {
          SaleTransactionID: {
            TransactionID: orderReference,
            TimeStamp: new Date().toISOString(),
          },
        },
        PaymentTransaction: {
          AmountsReq: {
            Currency: 'EUR',
            RequestedAmount: amountCents / 100,
          },
        },
      },
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    activePayment = null;

    if (!response.ok) {
      const text = await response.text();
      console.error('Adyen Terminal API fout:', response.status, text);
      return {
        success: false,
        error: `Fout bij verbinding met pinterminal (HTTP ${response.status})`,
      };
    }

    const data = await response.json();
    const paymentResponse = data.SaleToPOIResponse?.PaymentResponse;

    if (!paymentResponse) {
      return { success: false, error: 'Geen antwoord van pinterminal ontvangen' };
    }

    const result = paymentResponse.Response?.Result;

    if (result === 'Success') {
      const pspRef = paymentResponse.POIData?.POITransactionID?.TransactionID || '';
      return { success: true, reference: pspRef };
    }

    // Payment failed
    const errorCondition = paymentResponse.Response?.ErrorCondition || '';
    const additionalResponse = paymentResponse.Response?.AdditionalResponse || '';
    const errorMessage = getErrorMessage(errorCondition, additionalResponse);

    return { success: false, error: errorMessage };
  } catch (err) {
    activePayment = null;

    if (err.name === 'AbortError') {
      return {
        success: false,
        error: 'Pinbetaling timeout — geen reactie van terminal binnen 3 minuten. Controleer of de terminal aanstaat en 4G verbinding heeft.',
      };
    }

    console.error('Adyen Terminal API fout:', err.message);
    return {
      success: false,
      error: `Kan geen verbinding maken met pinterminal: ${err.message}`,
    };
  }
}

/**
 * Cancel an active pin payment
 */
async function cancelPayment() {
  if (!activePayment) {
    return { success: false, error: 'Geen actieve pinbetaling om te annuleren' };
  }

  const apiKey = process.env.ADYEN_API_KEY;
  const environment = process.env.ADYEN_ENVIRONMENT || 'test';
  const endpoint = ENDPOINTS[environment] || ENDPOINTS.test;

  const payload = {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0',
        MessageClass: 'Service',
        MessageCategory: 'Abort',
        MessageType: 'Request',
        ServiceID: uuidv4().substring(0, 10),
        SaleID: 'POSSystem',
        POIID: activePayment.poiid,
      },
      AbortRequest: {
        AbortReason: 'MerchantAbort',
        MessageReference: {
          MessageCategory: 'Payment',
          ServiceID: activePayment.serviceId,
          SaleID: 'POSSystem',
          POIID: activePayment.poiid,
        },
      },
    },
  };

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    activePayment = null;
    return { success: true };
  } catch (err) {
    console.error('Fout bij annuleren pinbetaling:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get Dutch error message for Adyen error conditions
 */
function getErrorMessage(errorCondition, additionalResponse) {
  const messages = {
    Refusal: 'Betaling geweigerd door de bank',
    Aborted: 'Betaling geannuleerd',
    Cancel: 'Betaling geannuleerd door klant',
    DeviceOut: 'Pinterminal niet bereikbaar — controleer 4G verbinding',
    InsertedCard: 'Kaart niet herkend — probeer opnieuw',
    NotAllowed: 'Transactie niet toegestaan',
    WrongPIN: 'Verkeerde pincode ingevoerd',
    InvalidCard: 'Ongeldige kaart',
    MessageFormat: 'Technische fout — neem contact op met beheerder',
    UnavailableDevice: 'Pinterminal niet beschikbaar',
    Busy: 'Pinterminal is bezet — wacht even en probeer opnieuw',
  };

  return messages[errorCondition] || `Betaling mislukt: ${errorCondition || 'onbekende fout'}`;
}

module.exports = {
  initiatePayment,
  cancelPayment,
};
