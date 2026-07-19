/**
 * Specialist: payment-config
 * Detects payment integration (Stripe, LemonSqueezy, Paddle) and checks if
 * webhook route + env vars are configured. stripe-replit-sync auto-handles
 * webhooks on Replit; other platforms need manual setup.
 */

export const checkId = 'payment-config';
export const name = 'Payment Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const PAYMENT_PACKAGES = [
  'stripe', '@stripe/stripe-js', '@stripe/react-stripe-js', 'stripe-replit-sync',
  'lemonsqueezy.js', '@lemonsqueezy/lemonsqueezy.js',
  'paddle-sdk', '@paddle/paddle-node-sdk', 'paddlejs',
];

const STRIPE_PACKAGES = ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js', 'stripe-replit-sync'];

const isFile = (p) => !p.endsWith('/');

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    // Step 1: package.json deps — zero file reads, return early if no payment
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    if (!PAYMENT_PACKAGES.some(p => deps[p])) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No payment integration detected', findings: [] };
    }
    const hasStripe = STRIPE_PACKAGES.some(p => deps[p]);
    const replitSync = !!deps['stripe-replit-sync'];

    // Step 2: webhook route + webhook secret env var (up to 8 file reads)
    const named = tree.filter(p => isFile(p) && /\/(webhook|stripe|payment)/.test(p) && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p)).slice(0, 5);
    const api = tree.filter(p => isFile(p) && /\/api\//.test(p) && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p)).slice(0, 5);
    const toScan = [...new Set([...named, ...api])].slice(0, 8);

    let webhookFile = replitSync ? 'stripe-replit-sync' : null;
    let hasWebhookSecret = replitSync;

    for (const filePath of toScan) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        if (/constructEvent/.test(content) || (/webhook/i.test(content) && /stripe|lemonsqueezy|paddle/i.test(content))) {
          webhookFile = webhookFile || filePath;
        }
        if (/WEBHOOK_SECRET/.test(content)) hasWebhookSecret = true;
      } catch { /* skip unreadable file */ }
    }

    // Step 3: hardcoded Stripe secret key in frontend components (up to 5 reads)
    const frontend = tree.filter(p => isFile(p) && /\.(tsx|jsx)$/.test(p) && !/node_modules/.test(p)).slice(0, 5);
    const findings = [];
    for (const filePath of frontend) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/sk_live_[a-zA-Z0-9]{24,}|sk_test_[a-zA-Z0-9]{24,}/.test(lines[i])) {
            findings.push({ file: filePath, line: i + 1, issue: 'Stripe secret key exposed in frontend — move to backend env var' });
          }
        }
      } catch { /* skip unreadable file */ }
    }
    if (findings.length > 0) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Stripe secret key exposed in frontend — move to backend env var immediately', findings };
    }

    // Step 4: .env.example documentation
    let hasEnvDoc = false;
    if (tree.includes('.env.example')) {
      try {
        const content = await files.get('.env.example');
        if (content && /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|LEMONSQUEEZY|PADDLE/.test(content)) hasEnvDoc = true;
      } catch { /* skip */ }
    }

    // Decision matrix
    const provider = hasStripe ? 'Stripe' : 'Payment integration';
    if (!webhookFile) {
      return { checkId, status: 'check-it', confidence: 'high',
        message: hasStripe
          ? 'Stripe detected but no webhook route — create /api/webhooks/stripe to handle payment events'
          : 'Payment integration detected but no webhook route — create an API route to handle payment events',
        findings: [
          { file: 'package.json', issue: `${provider} package detected` },
          { file: 'N/A', issue: hasStripe ? 'Create /api/webhooks/stripe route with stripe.webhooks.constructEvent()' : 'Create a webhook endpoint for your payment provider' },
        ] };
    }
    if (!hasWebhookSecret) {
      return { checkId, status: 'check-it', confidence: 'high',
        message: hasStripe
          ? 'Stripe detected but no STRIPE_WEBHOOK_SECRET env var — webhooks cannot be verified'
          : 'Payment integration detected but no webhook secret env var — webhooks cannot be verified',
        findings: [
          { file: webhookFile, issue: 'Webhook endpoint found' },
          { file: 'N/A', issue: hasStripe ? 'Add STRIPE_WEBHOOK_SECRET to your env vars' : 'Add your provider webhook secret to your env vars' },
        ] };
    }
    if (!hasEnvDoc) {
      return { checkId, status: 'check-it', confidence: 'medium',
        message: hasStripe
          ? 'Stripe configured but no .env.example — document STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET'
          : 'Payment configured but no .env.example — document your payment env vars',
        findings: [
          { file: webhookFile, issue: 'Webhook endpoint found' },
          { file: 'N/A', issue: 'Add .env.example documenting payment env vars' },
        ] };
    }
    return { checkId, status: 'pass', confidence: 'high',
      message: hasStripe ? 'Stripe configured: webhook endpoint + env vars documented' : 'Payment configured: webhook endpoint + env vars documented',
      findings: [
        { file: webhookFile, issue: 'Webhook endpoint found' },
        { file: '.env.example', issue: hasStripe ? 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET documented' : 'Payment env vars documented' },
      ] };
  } catch (err) {
    console.error('payment-config check error:', err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [{ file: 'internal', issue: err.message }] };
  }
}
