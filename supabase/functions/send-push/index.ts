import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { JWT } from "https://esm.sh/google-auth-library@8.7.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") || "";
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") || "";
const FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getAccessToken() {
  const client = new JWT({
    email: FIREBASE_CLIENT_EMAIL,
    key: FIREBASE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const tokens = await client.authorize();
  return tokens.access_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const payload = await req.json();
    const record = payload?.record || payload?.new_record || payload;
    const authorization = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || "", { global: { headers: { Authorization: authorization } } });
    const { data: { user: actor } } = await userClient.auth.getUser();
    if (!actor || String(actor.id) !== String(record?.sender_id)) return json({ error: "Unauthorized sender" }, 401);
    if (!record?.conversation_id || !record?.sender_id) return json({ error: "Invalid message payload" }, 400);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: conversation, error: conversationError } = await admin
      .from("conversations")
      .select("user_id, admin_id")
      .eq("id", record.conversation_id)
      .single();
    if (conversationError) throw conversationError;
    if (![conversation.user_id, conversation.admin_id].some((id) => String(id) === String(actor.id))) {
      return json({ error: "Sender is not a participant" }, 403);
    }

    const receiverId = String(record.sender_id) === String(conversation.user_id)
      ? conversation.admin_id
      : conversation.user_id;
    const { data: tokens, error: tokenError } = await admin
      .from("fcm_tokens")
      .select("token")
      .eq("user_id", receiverId);
    if (tokenError) throw tokenError;
    if (!tokens?.length) return json({ sent: 0 });

    const accessToken = await getAccessToken();
    const endpoint = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
    const body = record.content || (
      record.attachment_type === "image"
        ? "📷 صورة"
        : record.attachment_type === "video"
        ? "🎬 فيديو"
        : record.attachment_type === "audio"
        ? "🎤 رسالة صوتية"
        : "📎 ملف"
    );
    const results = await Promise.all(tokens.map(async ({ token }) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            data: {
              title: "رسالة جديدة",
              body,
              conversationId: String(record.conversation_id),
              senderId: String(record.sender_id),
              messageId: String(record.id || ""),
              icon: "/icons/icon.png",
              click_action: "/",
            },
            android: { priority: "high" },
            webpush: { headers: { Urgency: "high" } },
          },
        }),
      });
      return { status: response.status, body: await response.json() };
    }));
    return json({ sent: results.length, results });
  } catch (error) {
    console.error("send-push error", error);
    return json({ error: error?.message || "Push failed" }, 500);
  }
});
