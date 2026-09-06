// ============================================================
// إعدادات الاتصال — عدّل القيم التالية بمعلومات مشروعك في Supabase
// ============================================================
export const SUPABASE_URL = "https://eqzmvhwyfpoopqascgox.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxem12aHd5ZnBvb3BxYXNjZ294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NjY3NjMsImV4cCI6MjEwMzQ0Mjc2M30.8at9boBSCM27IJUJQLHuIvCPM95bSxCLGFUx3qn9PK4";

export const VAPID_PUBLIC_KEY = "BAxTu3HSXPEgeTyTRPoXvpkLQWu8llJQfsPEoUr0MDjHKRJ0VSzPFcJw5RFv-s6BTnZYeWEHW8NSQzAjfOxoJfo";

// قائمة المشرفين الثابتة (يجب أن تطابق دالة is_admin_email في schema.sql)
export const ADMINS = [
  { email: "aabntlal680@gmail.com", name: "الوليد بن طلال" },
  { email: "almgawell17@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell1992@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell1121@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell1212@gmail.com", name: "اسماء المليكي" },
];

export function isAdminEmail(email) {
  return ADMINS.some((a) => a.email.toLowerCase() === (email || "").toLowerCase());
}
