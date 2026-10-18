import { supabase } from "./supabaseClient.js";
import { isAdminEmail } from "./config.js";
import { removeFcmToken } from "./push.js";

export async function signUp({ email, password, displayName, phone }) {
  const normalizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: { display_name: displayName, phone: phone || null },
    },
  });
  if (error) throw error;

  // احتياطاً: تأكد من وجود صف profiles حتى لو تأخر الـ trigger (مثلاً عند تفعيل تأكيد البريد)
  if (data?.user) {
    try {
      await supabase
        .from("profiles")
        .upsert(
          {
            id: data.user.id,
            email: normalizedEmail,
            display_name: displayName,
            phone: phone || null,
            is_admin: isAdminEmail(normalizedEmail),
          },
          { onConflict: "id" }
        );
    } catch (err) {
      console.warn("Failed to upsert profile during signup:", err);
    }
  }
  return data;
}

export async function signIn({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });
  if (error) throw error;

  if (data?.user) {
    try {
      await supabase
        .from("profiles")
        .update({ is_online: true, last_seen: new Date().toISOString() })
        .eq("id", data.user.id);
    } catch (err) {
      console.warn("Failed to update profile online status on signIn:", err);
    }
  }
  return data;
}

export async function signOut(userId) {
  // تُحذف ملكية الرمز قبل signOut حتى تسمح RLS للمستخدم الحالي بالحذف.
  await removeFcmToken(userId);

  if (userId) {
    try {
      await supabase
        .from("profiles")
        .update({ is_online: false, last_seen: new Date().toISOString() })
        .eq("id", userId);
    } catch (err) {
      console.warn("Failed to update status on signOut:", err);
    }
  }
  
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error("Supabase auth signOut error:", err);
  }
}

export async function getCurrentProfile() {
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return null;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return null;

    const normalizedEmail = (profile.email || user.email || "").trim().toLowerCase();

    return {
      ...profile,
      is_admin: Boolean(profile.is_admin || isAdminEmail(normalizedEmail)),
      is_super_admin: Boolean(profile.is_super_admin || (normalizedEmail === "almgawell17@gmail.com")),
    };
  } catch (err) {
    console.error("getCurrentProfile error:", err);
    return null;
  }
}
