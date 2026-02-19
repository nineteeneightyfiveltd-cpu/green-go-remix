import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as secp256k1 from "https://esm.sh/@noble/secp256k1@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.4.0/sha256";
import { hmac } from "https://esm.sh/@noble/hashes@1.4.0/hmac";

// Initialize secp256k1
secp256k1.etc.hmacSha256Sync = (key: Uint8Array, ...messages: Uint8Array[]) => {
  const h = hmac.create(sha256, key);
  for (const msg of messages) h.update(msg);
  return h.digest();
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const API_BASE = "https://api.drgreennft.com/api/v1";

// --- Crypto helpers (matching drgreen-proxy) ---

function cleanBase64(input: string): string {
  let cleaned = input.replace(/[\r\n\s]/g, '');
  cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
  if (paddingNeeded > 0 && paddingNeeded < 4) cleaned += '='.repeat(paddingNeeded);
  return cleaned;
}

function base64ToBytes(base64: string): Uint8Array {
  const cleaned = cleanBase64(base64);
  const binaryString = atob(cleaned);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function isBase64(str: string): boolean {
  const cleaned = cleanBase64(str);
  if (!cleaned || cleaned.length === 0) return false;
  return /^[A-Za-z0-9+/]*=*$/.test(cleaned);
}

function extractSecp256k1PrivateKey(derBytes: Uint8Array): Uint8Array {
  if (derBytes.length === 32) return derBytes;

  let offset = 0;
  function readLength(): number {
    const firstByte = derBytes[offset++];
    if (firstByte < 0x80) return firstByte;
    const numBytes = firstByte & 0x7f;
    let length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | derBytes[offset++];
    return length;
  }

  // Outer SEQUENCE
  if (derBytes[offset++] !== 0x30) throw new Error('Expected SEQUENCE');
  readLength();

  const nextTag = derBytes[offset];
  if (nextTag === 0x02) {
    // Read version INTEGER
    offset++;
    const vLen = readLength();
    let version = 0;
    for (let i = 0; i < vLen; i++) version = (version << 8) | derBytes[offset + i];
    offset += vLen;

    if (version === 1) {
      // SEC1
      if (derBytes[offset++] !== 0x04) throw new Error('Expected OCTET STRING');
      const keyLen = readLength();
      if (keyLen !== 32) throw new Error(`Expected 32-byte key, got ${keyLen}`);
      return derBytes.slice(offset, offset + 32);
    } else if (version === 0) {
      // PKCS#8
      if (derBytes[offset++] !== 0x30) throw new Error('Expected SEQUENCE (algorithm)');
      const algLen = readLength();
      offset += algLen;
      if (derBytes[offset++] !== 0x04) throw new Error('Expected OCTET STRING');
      readLength();
      if (derBytes[offset++] !== 0x30) throw new Error('Expected SEQUENCE (SEC1)');
      readLength();
      if (derBytes[offset++] !== 0x02) throw new Error('Expected INTEGER (SEC1 version)');
      const sec1VersionLen = readLength();
      offset += sec1VersionLen;
      if (derBytes[offset++] !== 0x04) throw new Error('Expected OCTET STRING (private key)');
      const keyLen = readLength();
      if (keyLen !== 32) throw new Error(`Expected 32-byte key, got ${keyLen}`);
      return derBytes.slice(offset, offset + 32);
    }
  }
  throw new Error(`Unsupported key format`);
}

function signPayload(data: string, base64PrivateKey: string): string {
  const secret = (base64PrivateKey || '').trim();
  let decodedSecretBytes = base64ToBytes(secret);

  // Check for PEM format
  const decodedAsText = new TextDecoder().decode(decodedSecretBytes);
  let keyDerBytes: Uint8Array;

  const isPem = decodedAsText.includes('-----BEGIN') || decodedAsText.includes('BEGIN') ||
    (decodedSecretBytes.length >= 2 && decodedSecretBytes[0] === 0x2D && decodedSecretBytes[1] === 0x2D);

  if (isPem) {
    const pemBody = decodedAsText
      .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
      .replace(/-----END [A-Z0-9 ]+-----/g, '')
      .replace(/-{2,}[^\n]*\n?/g, '')
      .replace(/[\r\n\s]/g, '')
      .trim();
    if (!pemBody || !isBase64(pemBody)) throw new Error('Invalid PEM format');
    keyDerBytes = base64ToBytes(pemBody);
  } else {
    keyDerBytes = decodedSecretBytes;
  }

  const privateKeyBytes = extractSecp256k1PrivateKey(keyDerBytes);
  const dataBytes = new TextEncoder().encode(data);
  const messageHash = sha256(dataBytes);

  // Sign with secp256k1
  const signature = secp256k1.sign(messageHash, privateKeyBytes);

  // Use toCompactRawBytes + manual DER (toDERRawBytes doesn't exist)
  const compactSig = signature.toCompactRawBytes();
  const r = compactSig.slice(0, 32);
  const s = compactSig.slice(32, 64);

  function integerToDER(val: Uint8Array): Uint8Array {
    let start = 0;
    while (start < val.length - 1 && val[start] === 0) start++;
    let trimmed = val.slice(start);
    const needsPadding = trimmed[0] >= 0x80;
    const result = new Uint8Array((needsPadding ? 1 : 0) + trimmed.length);
    if (needsPadding) result[0] = 0x00;
    result.set(trimmed, needsPadding ? 1 : 0);
    return result;
  }

  const rDer = integerToDER(r);
  const sDer = integerToDER(s);
  const innerLen = 2 + rDer.length + 2 + sDer.length;
  const derSig = new Uint8Array(2 + innerLen);
  derSig[0] = 0x30;
  derSig[1] = innerLen;
  derSig[2] = 0x02;
  derSig[3] = rDer.length;
  derSig.set(rDer, 4);
  derSig[4 + rDer.length] = 0x02;
  derSig[5 + rDer.length] = sDer.length;
  derSig.set(sDer, 6 + rDer.length);

  return bytesToBase64(derSig);
}

// --- Main handler ---

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    // Allow internal calls with the internal-sync header
    const internalSyncHeader = req.headers.get('x-internal-sync');
    const isInternalSync = internalSyncHeader === 'true';

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    if (!isInternalSync) {
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userClient = createClient(supabaseUrl, supabaseAnon, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: roleData } = await adminClient
        .from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle();

      if (!roleData) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const apiKey = Deno.env.get('DRGREEN_API_KEY')!;
    const privateKey = Deno.env.get('DRGREEN_PRIVATE_KEY')!;

    // Fetch all auth users (service role)
    const { data: { users: authUsers } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
    const emailToUserId = new Map<string, string>();
    for (const u of authUsers || []) {
      if (u.email) emailToUserId.set(u.email.toLowerCase(), u.id);
    }
    console.log(`[SyncClients] Found ${emailToUserId.size} auth users`);

    // Paginate Dr. Green API clients
    let page = 1;
    const take = 50;
    let totalSynced = 0, totalCreated = 0, totalUpdated = 0, totalUnlinked = 0;
    let hasMore = true;

    while (hasMore) {
      const queryParams: Record<string, string | number> = { page, take, orderBy: 'desc' };
      const qs = Object.entries(queryParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');

      const signature = signPayload(qs, privateKey);
      const url = `${API_BASE}/dapp/clients?${qs}`;

      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-apikey': apiKey,
          'x-auth-signature': signature,
        },
      });

      if (!resp.ok) {
        console.error(`[SyncClients] API error page ${page}: ${resp.status}`);
        break;
      }

      const json = await resp.json() as { data?: { clients?: Array<Record<string, unknown>> } };
      const clients = json.data?.clients || [];

      if (clients.length === 0) { hasMore = false; break; }

      for (const client of clients) {
        const clientId = client.id as string;
        const email = (client.email as string || '').toLowerCase();
        const firstName = client.firstName as string || '';
        const lastName = client.lastName as string || '';
        const isKYCVerified = client.isKYCVerified as boolean || false;
        const adminApproval = client.adminApproval as string || 'PENDING';
        const shippings = client.shippings as Array<{ country?: string }> || [];
        const phoneCountryCode = client.phoneCountryCode as string || '';
        const countryCode = shippings[0]?.country || phoneCountryCode || 'PT';

        const { data: existing } = await adminClient
          .from('drgreen_clients').select('id, is_kyc_verified, admin_approval, user_id')
          .eq('drgreen_client_id', clientId).maybeSingle();

        if (existing) {
          if (existing.is_kyc_verified !== isKYCVerified || existing.admin_approval !== adminApproval) {
            await adminClient.from('drgreen_clients').update({
              is_kyc_verified: isKYCVerified, admin_approval: adminApproval,
              email, full_name: `${firstName} ${lastName}`.trim(),
              country_code: countryCode, updated_at: new Date().toISOString(),
            }).eq('id', existing.id);
            totalUpdated++;
          }
          totalSynced++;
        } else {
          const userId = emailToUserId.get(email);
          if (userId) {
            const { data: userExisting } = await adminClient
              .from('drgreen_clients').select('id').eq('user_id', userId).maybeSingle();

            if (userExisting) {
              await adminClient.from('drgreen_clients').update({
                drgreen_client_id: clientId, is_kyc_verified: isKYCVerified,
                admin_approval: adminApproval, email,
                full_name: `${firstName} ${lastName}`.trim(),
                country_code: countryCode, updated_at: new Date().toISOString(),
              }).eq('id', userExisting.id);
              totalUpdated++;
            } else {
              await adminClient.from('drgreen_clients').insert({
                user_id: userId, drgreen_client_id: clientId,
                is_kyc_verified: isKYCVerified, admin_approval: adminApproval,
                email, full_name: `${firstName} ${lastName}`.trim(), country_code: countryCode,
              });
              totalCreated++;
            }
            totalSynced++;
        } else {
            // Store unlinked client with null user_id — Dr. Green is source of truth
            await adminClient.from('drgreen_clients').insert({
              user_id: null as any,
              drgreen_client_id: clientId,
              is_kyc_verified: isKYCVerified,
              admin_approval: adminApproval,
              email: email || null,
              full_name: `${firstName} ${lastName}`.trim() || null,
              country_code: countryCode,
            });
            totalCreated++;
            totalSynced++;
          }
        }
      }

      hasMore = clients.length === take;
      page++;
      if (page > 20) break;
    }

    // --- Order Sync ---
    let orderPage = 1;
    let totalOrdersSynced = 0, totalOrdersCreated = 0, totalOrdersUpdated = 0;
    let hasMoreOrders = true;

    while (hasMoreOrders) {
      const orderQs = `page=${orderPage}&take=${take}&orderBy=desc`;
      const orderSig = signPayload(orderQs, privateKey);
      const orderUrl = `${API_BASE}/dapp/orders?${orderQs}`;

      const orderResp = await fetch(orderUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-apikey': apiKey,
          'x-auth-signature': orderSig,
        },
      });

      if (!orderResp.ok) {
        console.error(`[SyncClients] Orders API error page ${orderPage}: ${orderResp.status}`);
        break;
      }

      const orderJson = await orderResp.json() as { data?: { orders?: Array<Record<string, unknown>> } };
      const orders = orderJson.data?.orders || [];

      if (orders.length === 0) { hasMoreOrders = false; break; }

      for (const order of orders) {
        const orderId = order.id as string;
        const clientId = order.clientId as string || '';
        const status = order.status as string || 'PENDING';
        const paymentStatus = order.paymentStatus as string || 'PENDING';
        const totalAmount = Number(order.totalAmount || order.total || 0);
        const currency = order.currency as string || 'EUR';
        const customerEmail = (order.email as string) || '';
        const customerName = (order.customerName as string) || '';
        const items = order.items || [];
        const shippingAddress = order.shippingAddress || null;
        const countryCode = order.countryCode as string || '';

        // Match client to get user_id
        const { data: clientRow } = await adminClient
          .from('drgreen_clients').select('user_id')
          .eq('drgreen_client_id', clientId).maybeSingle();

        const userId = clientRow?.user_id || null;

        const { data: existingOrder } = await adminClient
          .from('drgreen_orders').select('id, status, payment_status')
          .eq('drgreen_order_id', orderId).maybeSingle();

        if (existingOrder) {
          if (existingOrder.status !== status || existingOrder.payment_status !== paymentStatus) {
            await adminClient.from('drgreen_orders').update({
              status, payment_status: paymentStatus, total_amount: totalAmount,
              currency, customer_email: customerEmail, customer_name: customerName,
              items: items as any, shipping_address: shippingAddress as any,
              country_code: countryCode, client_id: clientId,
              user_id: userId as any,
              synced_at: new Date().toISOString(), sync_status: 'synced',
              updated_at: new Date().toISOString(),
            }).eq('id', existingOrder.id);
            totalOrdersUpdated++;
          }
          totalOrdersSynced++;
        } else {
          await adminClient.from('drgreen_orders').insert({
            drgreen_order_id: orderId, user_id: userId as any,
            client_id: clientId, status, payment_status: paymentStatus,
            total_amount: totalAmount, currency,
            customer_email: customerEmail, customer_name: customerName,
            items: items as any, shipping_address: shippingAddress as any,
            country_code: countryCode,
            synced_at: new Date().toISOString(), sync_status: 'synced',
          });
          totalOrdersCreated++;
          totalOrdersSynced++;
        }
      }

      hasMoreOrders = orders.length === take;
      orderPage++;
      if (orderPage > 20) break;
    }

    const result = {
      success: true,
      clients: { synced: totalSynced, created: totalCreated, updated: totalUpdated, unlinked: totalUnlinked },
      orders: { synced: totalOrdersSynced, created: totalOrdersCreated, updated: totalOrdersUpdated },
      syncedAt: new Date().toISOString(),
    };
    console.log(`[SyncClients] Complete:`, result);

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[SyncClients] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
