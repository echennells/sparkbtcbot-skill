import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { decode } from "light-bolt11-decoder";

if (!process.env.SPARK_MNEMONIC) {
  console.error("SPARK_MNEMONIC not set. Run wallet-setup.js first.");
  process.exit(1);
}

const network = process.env.SPARK_NETWORK || "MAINNET";

// L402 test endpoint (returns a joke after payment)
const L402_TEST_URL = "https://lightningfaucet.com/api/l402/joke";

/**
 * Fetch content from L402-protected endpoint.
 * If 402 Payment Required, pays the Lightning invoice and retries.
 */
async function fetchWithL402(wallet, url, options = {}) {
  const { method = "GET", headers = {}, body, maxFeeSats = 10 } = options;

  // Step 1: Make initial request
  const initialResponse = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  // If not 402, return response directly
  if (initialResponse.status !== 402) {
    const contentType = initialResponse.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return { paid: false, data: await initialResponse.json() };
    }
    return { paid: false, data: await initialResponse.text() };
  }

  console.log("Got 402 Payment Required, parsing challenge...");

  // Step 2: Parse 402 challenge
  const challenge = await initialResponse.json();
  const invoice = challenge.invoice || challenge.payment_request || challenge.pr;
  const macaroon = challenge.macaroon || challenge.token;

  if (!invoice || !macaroon) {
    throw new Error("Invalid L402 response: missing invoice or macaroon");
  }

  // Step 3: Decode invoice to get amount
  const decoded = decode(invoice);
  const amountSection = decoded.sections.find((s) => s.name === "amount");
  if (!amountSection?.value) {
    throw new Error("L402 invoice has no amount");
  }
  const amountSats = Math.ceil(Number(amountSection.value) / 1000);
  console.log(`Invoice amount: ${amountSats} sats`);

  // Step 4: Pay the invoice
  console.log("Paying invoice...");
  const payResult = await wallet.payLightningInvoice({
    invoice,
    maxFeeSats,
  });

  // Get preimage (may need to poll if payment is async)
  let preimage = payResult.paymentPreimage;
  if (!preimage && payResult.status === "LIGHTNING_PAYMENT_INITIATED") {
    console.log("Payment initiated, polling for preimage...");
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const status = await wallet.getLightningSendRequest(payResult.id);
      if (status?.paymentPreimage) {
        preimage = status.paymentPreimage;
        break;
      }
      if (status?.status === "LIGHTNING_PAYMENT_FAILED") {
        throw new Error("L402 payment failed");
      }
    }
  }

  if (!preimage) {
    throw new Error("L402 payment succeeded but no preimage available");
  }

  console.log("Payment complete, preimage:", preimage.slice(0, 16) + "...");

  // Step 5: Retry with L402 authorization
  console.log("Fetching protected content...");
  const finalResponse = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `L402 ${macaroon}:${preimage}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = finalResponse.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await finalResponse.json();
  } else {
    data = await finalResponse.text();
  }

  return {
    paid: true,
    amountSats,
    preimage,
    macaroon,
    data,
  };
}

/**
 * Preview L402 cost without paying
 */
async function previewL402(url) {
  const response = await fetch(url);

  if (response.status !== 402) {
    return { requiresPayment: false };
  }

  const challenge = await response.json();
  const invoice = challenge.invoice || challenge.payment_request || challenge.pr;

  const decoded = decode(invoice);
  const amountSection = decoded.sections.find((s) => s.name === "amount");
  const amountSats = Math.ceil(Number(amountSection.value) / 1000);

  return {
    requiresPayment: true,
    amountSats,
    invoice,
    macaroon: challenge.macaroon,
  };
}

async function main() {
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: process.env.SPARK_MNEMONIC,
    options: { network },
  });

  const { balance } = await wallet.getBalance();
  console.log("Current balance:", balance.toString(), "sats\n");

  // --- Preview L402 Cost ---
  console.log("=== Preview L402 Cost ===");
  console.log(`Checking ${L402_TEST_URL}...`);
  const preview = await previewL402(L402_TEST_URL);

  if (!preview.requiresPayment) {
    console.log("No payment required for this endpoint.\n");
  } else {
    console.log(`Payment required: ${preview.amountSats} sats`);
    console.log(`Invoice: ${preview.invoice.slice(0, 50)}...\n`);
  }

  // --- Fetch with L402 Payment ---
  // Uncomment to actually pay and fetch:
  //
  // console.log("=== Fetch with L402 Payment ===");
  // const result = await fetchWithL402(wallet, L402_TEST_URL, {
  //   maxFeeSats: 10,
  // });
  // console.log("Paid:", result.paid);
  // console.log("Amount:", result.amountSats, "sats");
  // console.log("Data:", result.data);

  wallet.cleanupConnections();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
