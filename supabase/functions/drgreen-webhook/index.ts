import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature',
};

// Log level configuration - defaults to INFO in production
const LOG_LEVEL = Deno.env.get('LOG_LEVEL') || 'INFO';
const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function shouldLog(level: string): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function logInfo(message: string, data?: Record<string, unknown>) {
  if (shouldLog('INFO')) {
    console.log(`[Info] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

function logWarn(message: string, data?: Record<string, unknown>) {
  if (shouldLog('WARN')) {
    console.warn(`[Warn] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

function logError(message: string, data?: Record<string, unknown>) {
  if (shouldLog('ERROR')) {
    console.error(`[Error] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

// Sanitize data for logging - redact sensitive fields
function sanitizeForLogging(data: Record<string, unknown>): Record<string, unknown> {
  const sensitiveFields = ['email', 'phone', 'name', 'signature', 'kycLink', 'rejectionReason'];
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveFields.some(f => lowerKey.includes(f.toLowerCase()));
    if (isSensitive && typeof value === 'string') {
      sanitized[key] = value.length > 6 ? `${value.slice(0, 3)}***` : '***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = '[Object]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// Webhook timestamp validation (max 5 minutes old)
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

// Multi-domain configuration for Healing Buds regions
const DOMAIN_CONFIG: Record<string, { domain: string; brandName: string; sendDomain: string }> = {
  'ZA': { domain: 'healingbuds.co.za', brandName: 'Healing Buds South Africa', sendDomain: 'send.healingbuds.co.za' },
  'PT': { domain: 'healingbuds.pt', brandName: 'Healing Buds Portugal', sendDomain: 'send.healingbuds.pt' },
  'GB': { domain: 'healingbuds.co.uk', brandName: 'Healing Buds UK', sendDomain: 'send.healingbuds.co.uk' },
  'global': { domain: 'healingbuds.global', brandName: 'Healing Buds', sendDomain: 'send.healingbuds.co.za' },
};

function getDomainConfig(region?: string) {
  const regionKey = region?.toUpperCase() || 'global';
  return DOMAIN_CONFIG[regionKey] || DOMAIN_CONFIG['global'];
}

// Verify webhook signature from Dr Green API
async function verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(payload + secret);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex === signature || btoa(String.fromCharCode(...new Uint8Array(hashBuffer))) === signature;
  } catch (error) {
    logError('Signature verification error');
    return false;
  }
}

// Validate webhook timestamp to prevent replay attacks
function validateWebhookTimestamp(timestamp: string): boolean {
  try {
    const webhookTime = new Date(timestamp).getTime();
    const now = Date.now();
    const age = now - webhookTime;
    
    // Reject webhooks older than 5 minutes or from the future
    if (age > MAX_WEBHOOK_AGE_MS || age < -60000) {
      logWarn('Webhook timestamp validation failed', { age: Math.round(age / 1000) });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Validate client state transitions
const VALID_STATE_TRANSITIONS: Record<string, string[]> = {
  'PENDING': ['VERIFIED', 'REJECTED'],
  'VERIFIED': ['REJECTED'], // Admin can revoke
  'REJECTED': ['PENDING'], // User can retry
};

function isValidStateTransition(currentState: string | null, newState: string): boolean {
  const current = currentState || 'PENDING';
  const validNext = VALID_STATE_TRANSITIONS[current] || [];
  return validNext.includes(newState);
}

interface WebhookPayload {
  event: string;
  orderId?: string;
  clientId?: string;
  strainId?: string;
  status?: string;
  paymentStatus?: string;
  kycStatus?: string;
  adminApproval?: string;
  rejectionReason?: string;
  kycLink?: string;
  timestamp: string;
  data?: Record<string, unknown>;
  // Inventory-specific fields
  stock?: number;
  availability?: boolean;
  countryCode?: string;
}

// Validate webhook payload structure
function validateWebhookPayload(payload: unknown): payload is WebhookPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  
  // Required fields
  if (typeof p.event !== 'string' || p.event.length === 0 || p.event.length > 100) return false;
  if (typeof p.timestamp !== 'string') return false;
  
  // Optional string fields validation
  const stringFields = ['orderId', 'clientId', 'strainId', 'status', 'paymentStatus', 'kycStatus', 'adminApproval', 'rejectionReason', 'kycLink', 'countryCode'];
  for (const field of stringFields) {
    if (p[field] !== undefined && (typeof p[field] !== 'string' || (p[field] as string).length > 500)) {
      return false;
    }
  }
  
  // Optional number fields validation
  if (p.stock !== undefined && (typeof p.stock !== 'number' || p.stock < 0)) return false;
  if (p.availability !== undefined && typeof p.availability !== 'boolean') return false;
  
  return true;
}

// Email template for order status updates
function getOrderStatusEmail(orderId: string, status: string, event: string, config: typeof DOMAIN_CONFIG['global']): { subject: string; html: string } {
  const statusMessages: Record<string, { subject: string; body: string; color: string }> = {
    'order.shipped': {
      subject: '🚚 Your order has been shipped!',
      body: 'Great news! Your order has been shipped and is on its way to you.',
      color: '#3b82f6',
    },
    'order.delivered': {
      subject: '✅ Your order has been delivered!',
      body: 'Your order has been successfully delivered. We hope you enjoy your products!',
      color: '#22c55e',
    },
    'order.cancelled': {
      subject: '❌ Your order has been cancelled',
      body: 'Your order has been cancelled. If you have any questions, please contact our support team.',
      color: '#ef4444',
    },
    'payment.completed': {
      subject: '💳 Payment confirmed for your order',
      body: 'Your payment has been successfully processed. Your order is now being prepared.',
      color: '#22c55e',
    },
    'payment.failed': {
      subject: '⚠️ Payment failed for your order',
      body: 'Unfortunately, your payment could not be processed. Please try again or contact support.',
      color: '#ef4444',
    },
    'order.status_updated': {
      subject: `📦 Order status update: ${status}`,
      body: `Your order status has been updated to: ${status}`,
      color: '#8b5cf6',
    },
  };

  const template = statusMessages[event] || statusMessages['order.status_updated'];

  return {
    subject: template.subject,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5; margin: 0; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <div style="background-color: ${template.color}; padding: 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px;">${config.brandName}</h1>
          </div>
          <div style="padding: 32px;">
            <p style="color: #18181b; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
              ${template.body}
            </p>
            <div style="background-color: #f4f4f5; border-radius: 8px; padding: 16px; margin: 24px 0;">
              <p style="margin: 0; color: #71717a; font-size: 14px;">Order ID</p>
              <p style="margin: 4px 0 0 0; color: #18181b; font-size: 18px; font-family: monospace; font-weight: 600;">
                ${orderId}
              </p>
            </div>
            <div style="text-align: center; margin-top: 32px;">
              <a href="https://${config.domain}/orders" style="display: inline-block; background-color: ${template.color}; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-weight: 600;">
                View Order Details
              </a>
            </div>
          </div>
          <div style="background-color: #f4f4f5; padding: 20px; text-align: center;">
            <p style="margin: 0; color: #71717a; font-size: 12px;">
              ${config.brandName} Medical Cannabis
            </p>
            <p style="margin: 8px 0 0 0; color: #a1a1aa; font-size: 11px;">
              This is an automated message. Please do not reply to this email.
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
  };
}

// Send email using Resend API via fetch
async function sendEmail(to: string, subject: string, html: string, config: typeof DOMAIN_CONFIG['global']): Promise<boolean> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    logInfo('RESEND_API_KEY not configured, skipping email');
    return false;
  }

  try {
    // Use verified domain or fallback to resend.dev
    const fromAddress = `${config.brandName} <noreply@${config.sendDomain}>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        subject,
        html,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      logError('Resend API error');
      return false;
    }

    logInfo('Email sent successfully');
    return true;
  } catch (error) {
    logError('Email sending failed');
    return false;
  }
}

// Send client email via the dedicated edge function
async function sendClientEmail(
  supabaseUrl: string,
  supabaseKey: string,
  type: string,
  email: string,
  name: string,
  region?: string,
  kycLink?: string,
  rejectionReason?: string
): Promise<boolean> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/send-client-email`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type,
        email,
        name,
        region,
        kycLink,
        rejectionReason,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      logError('send-client-email error');
      return false;
    }

    logInfo(`Client email (${type}) sent successfully`);
    return true;
  } catch (error) {
    logError('Client email sending failed');
    return false;
  }
}

// Helper to log KYC journey events
async function logJourneyEvent(
  supabase: any,
  userId: string,
  clientId: string,
  eventType: string,
  eventData: Record<string, unknown> = {}
): Promise<void> {
  try {
    // Sanitize event data before storing
    const sanitizedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(eventData)) {
      if (typeof value === 'boolean' || typeof value === 'number') {
        sanitizedData[key] = value;
      } else if (typeof value === 'string' && value.length <= 500) {
        sanitizedData[key] = value;
      }
    }
    
    await supabase.from('kyc_journey_logs').insert({
      user_id: userId,
      client_id: clientId,
      event_type: eventType,
      event_source: 'drgreen-webhook',
      event_data: sanitizedData,
    });
    logInfo(`KYC Journey logged: ${eventType}`);
  } catch (error) {
    logWarn('Failed to log KYC journey event');
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const rawPayload = await req.text();
    const signature = req.headers.get('x-webhook-signature') || '';
    const privateKey = Deno.env.get("DRGREEN_PRIVATE_KEY");

    // Verify webhook signature (required)
    if (privateKey && signature) {
      const isValid = await verifyWebhookSignature(rawPayload, signature, privateKey);
      if (!isValid) {
        logError('Invalid webhook signature');
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else if (privateKey) {
      // If we have a key but no signature, reject
      logError('Missing webhook signature');
      return new Response(
        JSON.stringify({ error: "Missing signature" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsedPayload = JSON.parse(rawPayload);
    
    // Validate payload structure
    if (!validateWebhookPayload(parsedPayload)) {
      logError('Invalid webhook payload structure');
      return new Response(
        JSON.stringify({ error: "Invalid payload structure" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    const payload: WebhookPayload = parsedPayload;
    
    // Validate timestamp to prevent replay attacks
    if (!validateWebhookTimestamp(payload.timestamp)) {
      logError('Webhook timestamp validation failed');
      return new Response(
        JSON.stringify({ error: "Webhook expired or invalid timestamp" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    logInfo('Processing webhook', { event: payload.event });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let emailSent = false;

    // Handle KYC and client-related events
    if (payload.clientId && (payload.event.startsWith('kyc.') || payload.event.startsWith('client.'))) {
      logInfo(`Processing client event: ${payload.event}`);

      // Verify clientId exists in database
      const { data: clientData, error: clientError } = await supabase
        .from('drgreen_clients')
        .select('user_id, country_code, admin_approval')
        .eq('drgreen_client_id', payload.clientId)
        .single();

      if (clientError || !clientData?.user_id) {
        logWarn('Client not found for webhook', { clientId: payload.clientId?.slice(0, 10) });
        return new Response(
          JSON.stringify({ error: "Client not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: userData } = await supabase.auth.admin.getUserById(clientData.user_id);
      const userEmail = userData?.user?.email;
      const userName = userData?.user?.user_metadata?.full_name || 'Patient';
      const region = clientData.country_code || 'global';

      if (userEmail) {
        switch (payload.event) {
          case 'kyc.link_generated': {
            // Send KYC link email
            if (payload.kycLink) {
              // Update KYC link in database
              await supabase
                .from('drgreen_clients')
                .update({ kyc_link: payload.kycLink })
                .eq('drgreen_client_id', payload.clientId);

              emailSent = await sendClientEmail(
                supabaseUrl,
                supabaseServiceKey,
                'kyc-link',
                userEmail,
                userName,
                region,
                payload.kycLink
              );
              
              // Log journey event
              await logJourneyEvent(supabase, clientData.user_id, payload.clientId, 'kyc.link_generated', {
                emailSent,
                linkPresent: !!payload.kycLink,
              });
            }
            break;
          }
          case 'kyc.verified':
          case 'kyc.approved': {
            // Update database
            await supabase
              .from('drgreen_clients')
              .update({ is_kyc_verified: true })
              .eq('drgreen_client_id', payload.clientId);

            emailSent = await sendClientEmail(
              supabaseUrl,
              supabaseServiceKey,
              'kyc-approved',
              userEmail,
              userName,
              region
            );
            
            // Log journey event
            await logJourneyEvent(supabase, clientData.user_id, payload.clientId, payload.event, {
              emailSent,
              status: 'verified',
            });
            break;
          }
          case 'kyc.rejected':
          case 'kyc.failed': {
            emailSent = await sendClientEmail(
              supabaseUrl,
              supabaseServiceKey,
              'kyc-rejected',
              userEmail,
              userName,
              region,
              payload.kycLink,
              payload.rejectionReason
            );
            
            // Log journey event
            await logJourneyEvent(supabase, clientData.user_id, payload.clientId, payload.event, {
              emailSent,
              status: 'rejected',
            });
            break;
          }
          case 'client.approved': {
            // Validate state transition
            if (!isValidStateTransition(clientData.admin_approval, 'VERIFIED')) {
              logWarn('Invalid state transition attempted', { 
                current: clientData.admin_approval, 
                new: 'VERIFIED' 
              });
            }
            
            // Update database
            await supabase
              .from('drgreen_clients')
              .update({ admin_approval: 'VERIFIED' })
              .eq('drgreen_client_id', payload.clientId);

            emailSent = await sendClientEmail(
              supabaseUrl,
              supabaseServiceKey,
              'eligibility-approved',
              userEmail,
              userName,
              region
            );
            
            // Log journey event
            await logJourneyEvent(supabase, clientData.user_id, payload.clientId, 'client.approved', {
              emailSent,
              adminApproval: 'VERIFIED',
              previousState: clientData.admin_approval,
            });
            break;
          }
          case 'client.rejected': {
            // Validate state transition
            if (!isValidStateTransition(clientData.admin_approval, 'REJECTED')) {
              logWarn('Invalid state transition attempted', { 
                current: clientData.admin_approval, 
                new: 'REJECTED' 
              });
            }
            
            // Update database
            await supabase
              .from('drgreen_clients')
              .update({ admin_approval: 'REJECTED' })
              .eq('drgreen_client_id', payload.clientId);

            emailSent = await sendClientEmail(
              supabaseUrl,
              supabaseServiceKey,
              'eligibility-rejected',
              userEmail,
              userName,
              region,
              undefined,
              payload.rejectionReason
            );
            
            // Log journey event
            await logJourneyEvent(supabase, clientData.user_id, payload.clientId, 'client.rejected', {
              emailSent,
              adminApproval: 'REJECTED',
              previousState: clientData.admin_approval,
            });
            break;
          }
          default:
            logInfo(`Unhandled client event: ${payload.event}`);
        }
      }

      return new Response(
        JSON.stringify({ success: true, event: payload.event, emailSent }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle inventory/stock update events
    if (payload.event.startsWith('inventory.') || payload.event.startsWith('stock.')) {
      logInfo(`Processing inventory event: ${payload.event}`);
      
      const stockUpdate = {
        strainId: payload.strainId,
        stock: payload.stock,
        availability: payload.availability,
        countryCode: payload.countryCode,
        event: payload.event,
        timestamp: payload.timestamp,
      };
      
      // Broadcast stock update via Supabase Realtime
      const channel = supabase.channel('stock-updates');
      
      await channel.send({
        type: 'broadcast',
        event: 'stock-change',
        payload: stockUpdate,
      });
      
      logInfo(`Broadcasted stock update for strain`);
      
      return new Response(
        JSON.stringify({ success: true, event: payload.event, broadcasted: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Handle order-related events
    if (payload.orderId) {
      // Verify order exists
      const { data: orderData, error: orderError } = await supabase
        .from('drgreen_orders')
        .select('user_id')
        .eq('drgreen_order_id', payload.orderId)
        .single();

      if (orderError || !orderData?.user_id) {
        logWarn('Order not found for webhook');
        return new Response(
          JSON.stringify({ error: "Order not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let userEmail: string | null = null;
      let region: string = 'global';

      const { data: userData } = await supabase.auth.admin.getUserById(orderData.user_id);
      userEmail = userData?.user?.email || null;

      // Get region from client data
      const { data: clientData } = await supabase
        .from('drgreen_clients')
        .select('country_code')
        .eq('user_id', orderData.user_id)
        .single();
      
      region = clientData?.country_code || 'global';

      const domainConfig = getDomainConfig(region);

      // Handle webhook events
      const updates: Record<string, string> = {};
      let shouldSendEmail = false;

      switch (payload.event) {
        case 'order.status_updated':
        case 'order.updated': {
          if (payload.status) updates.status = payload.status;
          if (payload.paymentStatus) updates.payment_status = payload.paymentStatus;
          shouldSendEmail = true;
          break;
        }
        case 'order.shipped': {
          updates.status = 'SHIPPED';
          shouldSendEmail = true;
          break;
        }
        case 'order.delivered': {
          updates.status = 'DELIVERED';
          shouldSendEmail = true;
          break;
        }
        case 'order.cancelled': {
          updates.status = 'CANCELLED';
          shouldSendEmail = true;
          break;
        }
        case 'payment.completed': {
          updates.payment_status = 'PAID';
          shouldSendEmail = true;
          break;
        }
        case 'payment.failed': {
          updates.payment_status = 'FAILED';
          shouldSendEmail = true;
          break;
        }
        default:
          logInfo(`Unhandled webhook event: ${payload.event}`);
      }

      // Update order in database
      if (Object.keys(updates).length > 0) {
        const { error } = await supabase
          .from('drgreen_orders')
          .update(updates)
          .eq('drgreen_order_id', payload.orderId);

        if (error) {
          logError('Error updating order');
        } else {
          logInfo(`Order updated successfully`);

          // Broadcast order-change event so any UI channel listener also gets notified
          try {
            const orderChannel = supabase.channel('order-updates');
            await orderChannel.send({
              type: 'broadcast',
              event: 'order-change',
              payload: {
                orderId: payload.orderId,
                status: updates.status || null,
                payment_status: updates.payment_status || null,
                event: payload.event,
              },
            });
            await supabase.removeChannel(orderChannel);
          } catch (broadcastErr) {
            logInfo('Order broadcast skipped (non-critical)');
          }
        }
      }

      // Send email notification
      if (shouldSendEmail && userEmail) {
        const emailContent = getOrderStatusEmail(
          payload.orderId,
          payload.status || updates.status || 'Updated',
          payload.event,
          domainConfig
        );
        emailSent = await sendEmail(userEmail, emailContent.subject, emailContent.html, domainConfig);
        if (emailSent) {
          logInfo(`Email sent for order notification`);
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, event: payload.event, emailSent }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError("Webhook error", { message });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
