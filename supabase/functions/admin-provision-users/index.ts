import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ADMIN_EMAILS = ["scott@healingbuds.global", "healingbudsglobal@gmail.com"];
const DEFAULT_PASSWORD = "12345678";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller is admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Check admin role
    const { data: roleData } = await adminClient
      .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!roleData) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all unlinked clients
    const { data: unlinkedClients, error: fetchError } = await adminClient
      .from("drgreen_clients")
      .select("id, email, full_name, drgreen_client_id")
      .is("user_id", null)
      .not("email", "is", null);

    if (fetchError) throw fetchError;

    const results = { created: 0, skipped: 0, failed: 0, details: [] as string[] };

    for (const client of unlinkedClients || []) {
      if (!client.email) { results.skipped++; continue; }

      try {
        // Try creating the auth user
        const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
          email: client.email,
          password: DEFAULT_PASSWORD,
          email_confirm: true,
        });

        let userId: string | null = null;

        if (createError) {
          // If user already exists, look them up
          if (createError.message?.includes("already been registered") || createError.message?.includes("already exists")) {
            const { data: { users } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
            const existing = users.find(u => u.email?.toLowerCase() === client.email.toLowerCase());
            if (existing) {
              userId = existing.id;
              results.details.push(`skipped (exists): ${client.email}`);
            } else {
              results.failed++;
              results.details.push(`failed (not found): ${client.email}`);
              continue;
            }
          } else {
            results.failed++;
            results.details.push(`failed (${createError.message}): ${client.email}`);
            continue;
          }
        } else {
          userId = newUser.user.id;
          results.created++;
          results.details.push(`created: ${client.email}`);
        }

        if (!userId) continue;

        // Link drgreen_clients record
        await adminClient.from("drgreen_clients").update({
          user_id: userId,
          updated_at: new Date().toISOString(),
        }).eq("id", client.id);

        // Upsert profile
        await adminClient.from("profiles").upsert({
          id: userId,
          full_name: client.full_name || client.email,
          updated_at: new Date().toISOString(),
        }, { onConflict: "id" });

        // Assign admin role if applicable
        if (ADMIN_EMAILS.includes(client.email.toLowerCase())) {
          await adminClient.from("user_roles").upsert({
            user_id: userId,
            role: "admin",
          }, { onConflict: "user_id,role", ignoreDuplicates: true });
          results.details.push(`  → admin role assigned: ${client.email}`);
        }

      } catch (err) {
        results.failed++;
        results.details.push(`error (${err instanceof Error ? err.message : "unknown"}): ${client.email}`);
      }
    }

    console.log("[ProvisionUsers] Complete:", results);

    return new Response(JSON.stringify({ success: true, ...results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[ProvisionUsers] Error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
