'use strict';

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// CORS
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://elizabetta.net',
    'https://elizabetta-2.myshopify.com'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const KLAVIYO_PRIVATE_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const EXTERNAL_WEBHOOK_SECRET = process.env.EXTERNAL_WEBHOOK_SECRET;
const TEXAS_LOCATION_ID = process.env.TEXAS_LOCATION_ID;
const JJ_POLAND_LOCATION_ID = process.env.JJ_POLAND_LOCATION_ID;
const JJ_UK_LOCATION_ID = process.env.JJ_UK_LOCATION_ID;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// ── OAuth Token Manager ───────────────────────────────────────────────────────
// Automatically fetches and caches access token using Client ID + Secret
// Never expires — refreshes itself if it ever gets a 401

let _cachedToken = process.env.SHOPIFY_ACCESS_TOKEN || null;
let _tokenFetching = false;

async function getAccessToken() {
  if (_cachedToken) return _cachedToken;
  if (_tokenFetching) {
    // Wait for ongoing fetch
    await new Promise(resolve => setTimeout(resolve, 2000));
    return _cachedToken;
  }

  _tokenFetching = true;
  try {
    console.log('[BIS] Fetching new access token via OAuth...');
    const response = await axios.post(
      `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        grant_type: 'client_credentials'
      }
    );
    _cachedToken = response.data.access_token;
    console.log('[BIS] Access token obtained successfully');
    return _cachedToken;
  } catch (err) {
    console.error('[BIS] Failed to get access token:', err.response?.data || err.message);
    // Fall back to env token if available
    _cachedToken = process.env.SHOPIFY_ACCESS_TOKEN || null;
    return _cachedToken;
  } finally {
    _tokenFetching = false;
  }
}

// Raw body needed for HMAC verification
app.use('/webhooks/inventory-update', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health Check ──────────────────────────────────────────────────────────────
const TOKEN_FINGERPRINT = crypto
  .createHash('md5')
  .update(process.env.SHOPIFY_ACCESS_TOKEN || '')
  .digest('hex')
  .slice(0, 8);

app.get('/health', async (req, res) => {
  let shopifyOk = false;
  let shopName = '';
  try {
    const data = await shopifyGraphQL(`{ shop { name } }`);
    shopName = data?.shop?.name || '';
    shopifyOk = !!shopName;
  } catch(e) {
    shopifyOk = false;
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    shopify_token_valid: shopifyOk,
    shopify_token_fingerprint: TOKEN_FINGERPRINT,
    shop: shopName,
    uptime_seconds: Math.floor(process.uptime())
  });
});

// ── Shopify GraphQL Helper ────────────────────────────────────────────────────
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/graphql.json`;
  const token = await getAccessToken();

  try {
    const response = await axios.post(
      url,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
      }
    );
    if (response.data.errors?.length) {
      throw new Error(`Shopify GraphQL error: ${response.data.errors.map(e => e.message).join(', ')}`);
    }
    return response.data.data;
  } catch (err) {
    // If 401 — clear cached token and retry once with fresh token
    if (err.response?.status === 401) {
      console.warn('[BIS] 401 detected — clearing cached token and retrying...');
      _cachedToken = null;
      const freshToken = await getAccessToken();
      const retry = await axios.post(
        url,
        { query, variables },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': freshToken,
          },
        }
      );
      if (retry.data.errors?.length) {
        throw new Error(`Shopify GraphQL error: ${retry.data.errors.map(e => e.message).join(', ')}`);
      }
      return retry.data.data;
    }
    throw err;
  }
}


// ── Fetch Matching Subscribers ────────────────────────────────────────────────
async function fetchMatchingSubscribers(variantGid, warehouse) {
  const query = `
    query GetBISSubs($after: String) {
      metaobjects(type: "sidekick_bis_subscriber", first: 50, after: $after) {
        edges {
          node {
            id
            f1: field(key: "email") { value }
            f3: field(key: "variant_id") { value }
            f4: field(key: "product_title") { value }
            f5: field(key: "variant_title") { value }
            f7: field(key: "warehouse") { value }
            f9: field(key: "notified") { value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const all = [];
  let cursor = null;
  while (true) {
    const data = await shopifyGraphQL(query, { after: cursor });
    const page = data.metaobjects;
    if (!page) break;
    for (const edge of page.edges) {
      const node = edge.node;
      if (
        node.f3?.value === variantGid &&
        node.f7?.value === warehouse &&
        node.f9?.value !== 'true'
      ) {
        all.push({
          id: node.id,
          email: node.f1?.value || '',
          product_title: node.f4?.value || '',
          variant_title: node.f5?.value || '',
          warehouse: node.f7?.value,
        });
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return all;
}

// ── Mark Subscriber Notified ──────────────────────────────────────────────────
async function markSubscriberNotified(id) {
  const mutation = `
    mutation UpdateBISSub($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    id,
    metaobject: {
      fields: [
        { key: 'notified', value: 'true' },
        { key: 'notified_at', value: new Date().toISOString() },
      ],
    },
  });
}

// ── Trigger Klaviyo Event ─────────────────────────────────────────────────────
async function triggerKlaviyoEvent(subscriber, variantGid) {
  const numericVariantId = variantGid.split('/').pop();
  await axios.post(
    'https://a.klaviyo.com/api/events/',
    {
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: 'Back In Stock' } } },
          profile: { data: { type: 'profile', attributes: { email: subscriber.email } } },
          properties: {
            product_title: subscriber.product_title,
            variant_title: subscriber.variant_title,
            variant_id: numericVariantId,
            warehouse: subscriber.warehouse,
          },
          value: 0,
          unique_id: `bis-${subscriber.email}-${numericVariantId}-${Date.now()}`,
          time: new Date().toISOString(),
        },
      },
    },
    {
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_PRIVATE_API_KEY}`,
        'Content-Type': 'application/json',
        revision: '2023-12-15',
      },
    }
  );
}

// ── Core Notification Logic ───────────────────────────────────────────────────
async function processRestock(variantGid, warehouse) {
  console.log(`[BIS] Restock: variant=${variantGid} warehouse=${warehouse}`);
  const subscribers = await fetchMatchingSubscribers(variantGid, warehouse);
  console.log(`[BIS] Found ${subscribers.length} matching subscriber(s)`);
  const results = { triggered: 0, failed: 0, errors: [] };
  for (const sub of subscribers) {
    try {
      await triggerKlaviyoEvent(sub, variantGid);
      await markSubscriberNotified(sub.id);
      results.triggered++;
      console.log(`[BIS] Notified: ${sub.email}`);
    } catch (err) {
      results.failed++;
      results.errors.push(`${sub.email}: ${err.message}`);
      console.error(`[BIS] Failed: ${sub.email}`, err.message);
    }
  }
  return results;
}

// ── Location → Warehouse Mapping ──────────────────────────────────────────────
function locationIdToWarehouse(locationId) {
  const id = String(locationId);
  if (id === String(TEXAS_LOCATION_ID)) return 'US';
  if (id === String(JJ_POLAND_LOCATION_ID)) return 'PL';
  if (id === String(JJ_UK_LOCATION_ID)) return 'UK';
  return null;
}

// ── HMAC Verification ─────────────────────────────────────────────────────────
function verifyShopifyHmac(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ── Route: Shopify Inventory Webhook ──────────────────────────────────────────
app.post('/webhooks/inventory-update', async (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn('[BIS] Invalid HMAC');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.status(200).json({ received: true }); // Respond fast to Shopify

  let payload;
  try { payload = JSON.parse(req.body.toString()); }
  catch (err) { return console.error('[BIS] Parse error:', err.message); }

  const { location_id, inventory_item_id, available } = payload;
  if (!available || available <= 0) return;

  const warehouse = locationIdToWarehouse(location_id);
  if (!warehouse) return console.log(`[BIS] Unknown location: ${location_id}`);

  try {
    const data = await shopifyGraphQL(
      `query GetVariant($id: ID!) {
        inventoryItem(id: $id) { variant { id title product { title } } }
      }`,
      { id: `gid://shopify/InventoryItem/${inventory_item_id}` }
    );
    const variant = data?.inventoryItem?.variant;
    if (!variant) return console.warn('[BIS] Variant not found');
    await processRestock(variant.id, warehouse);
  } catch (err) {
    console.error('[BIS] Inventory webhook error:', err.message);
  }
});

// ── Route: External Restock (J&J Control Port) ────────────────────────────────
app.post('/webhooks/external-restock', async (req, res) => {
  if (EXTERNAL_WEBHOOK_SECRET) {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (token !== EXTERNAL_WEBHOOK_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });
  }
  const { warehouse, variant_id, quantity } = req.body;
  if (!warehouse || !variant_id)
    return res.status(400).json({ error: 'Missing: warehouse, variant_id' });
  if (!['PL', 'UK'].includes(warehouse))
    return res.status(400).json({ error: 'warehouse must be "PL" or "UK"' });
  if (quantity !== undefined && quantity <= 0)
    return res.status(200).json({ message: 'Skipped: quantity not positive' });

  const variantGid = variant_id.startsWith('gid://')
    ? variant_id
    : `gid://shopify/ProductVariant/${variant_id}`;

  try {
    const results = await processRestock(variantGid, warehouse);
    return res.status(200).json({ success: true, ...results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Route: Manual Trigger ─────────────────────────────────────────────────────
app.post('/trigger-manual', async (req, res) => {
  const { warehouse, variant_id } = req.body;
  if (!warehouse || !variant_id)
    return res.status(400).json({ error: 'Missing: warehouse, variant_id' });
  if (!['US', 'PL', 'UK'].includes(warehouse))
    return res.status(400).json({ error: 'warehouse must be "US", "PL", or "UK"' });

  const variantGid = variant_id.startsWith('gid://')
    ? variant_id
    : `gid://shopify/ProductVariant/${variant_id}`;

  try {
    const results = await processRestock(variantGid, warehouse);
    return res.status(200).json({ success: true, ...results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ── Route: Storefront Subscribe (Klaviyo interceptor) ─────────────────────────
app.post('/storefront/subscribe', async (req, res) => {
  const { email, variant_id, region, product_title, variant_title, marketing_consent } = req.body;

  if (!email || !variant_id || !region) {
    return res.status(400).json({ error: 'Missing required fields: email, variant_id, region' });
  }

  // Map region to warehouse code
  const WAREHOUSE_MAP = {
    US: process.env.WAREHOUSE_CODE_US || 'US',
    EU: process.env.WAREHOUSE_CODE_EU || 'PL',
    ROW: process.env.WAREHOUSE_CODE_ROW || 'UK',
  };
  const warehouse = WAREHOUSE_MAP[region] || WAREHOUSE_MAP.ROW;

  const variantGid = variant_id.startsWith('gid://')
    ? variant_id
    : `gid://shopify/ProductVariant/${variant_id}`;

  const numericVariantId = variantGid.split('/').pop();

  // Fetch product/variant title from Shopify
  let productTitle = '';
  let variantTitle = '';
  let productId = '';
  try {
    const data = await shopifyGraphQL(
      `query GetVariant($id: ID!) {
        productVariant(id: $id) {
          id
          title
          product { id title }
        }
      }`,
      { id: variantGid }
    );
    const v = data?.productVariant;
    if (v) {
      variantTitle = v.title || '';
      productTitle = v.product?.title || '';
      productId = v.product?.id || '';
    }
  } catch (err) {
    console.warn('[BIS] Could not fetch variant details:', err.message);
  }

  // Build metaobject handle
  const slugEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40);
  const handle = `bis-${slugEmail}-${numericVariantId}`;
  const now = new Date().toISOString();

  // Upsert subscriber metaobject
  const mutation = `
    mutation UpsertBISSub($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message }
      }
    }
  `;

  try {
    const data = await shopifyGraphQL(mutation, {
      handle: { type: 'sidekick_bis_subscriber', handle },
      metaobject: {
        fields: [
          { key: 'email',          value: email },
          { key: 'product_id',     value: productId },
          { key: 'variant_id',     value: variantGid },
          { key: 'product_title', value: product_title || '' },
          { key: 'variant_title', value: variant_title || '' },
          { key: 'region',         value: region },
          { key: 'warehouse',      value: warehouse },
          { key: 'subscribed_at',  value: now },
          { key: 'notified',       value: 'false' },
          { key: 'notified_at',    value: '' },
        ],
      },
    });

    const errors = data?.metaobjectUpsert?.userErrors;
    if (errors?.length) {
      console.error('[BIS] Upsert errors:', errors);
      return res.status(500).json({ error: errors.map(e => e.message).join(', ') });
    }

    console.log(`[BIS] Subscriber saved: ${email} | ${region} → ${warehouse} | ${variantGid}`);

 
    // Subscribe profile to Klaviyo list for email consent 
    if (marketing_consent) {
        try {
          await axios.post(
            'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/',
            {
              data: {
                type: 'profile-subscription-bulk-create-job',
                attributes: {
                  profiles: {
                    data: [{
                      type: 'profile',
                      attributes: {
                        email: email,
                        subscriptions: {
                          email: { marketing: { consent: 'SUBSCRIBED' } }
                        }
                      }
                    }]
                  }
                },
                relationships: {
                  list: { data: { type: 'list', id: 'W552hZ' } }
                }
              }
            },
            {
              headers: {
                Authorization: `Klaviyo-API-Key ${KLAVIYO_PRIVATE_API_KEY}`,
                'Content-Type': 'application/json',
                revision: '2023-12-15'
              }
            }
          );
          console.log(`[BIS] Subscribed ${email} to Klaviyo list`);
        } catch (err) {
          console.warn(`[BIS] Klaviyo subscribe failed: ${err.message}`);
        }
    } 


    
    return res.status(200).json({ success: true, warehouse, region });

  } catch (err) {
    console.error('[BIS] Failed to save subscriber:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`[BIS] Server running on port ${PORT}`);
  console.log(`[BIS] Shop: ${SHOPIFY_SHOP_DOMAIN}`);
});
