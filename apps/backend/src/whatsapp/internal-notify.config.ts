// Internal WhatsApp notification env config.
//
// The `internal_enquiry_notification` template + the ops test recipient are
// read from env so they can be swapped without a code change. These are
// DISTINCT from the lead-chat template envs (WA_TEMPLATE_CHAT_REPLY etc.).
export const WHATSAPP_RECIPIENT_1 = process.env['WHATSAPP_RECIPIENT_1'] ?? null;
export const WHATSAPP_INTERNAL_TEMPLATE_NAME =
  process.env['WHATSAPP_INTERNAL_TEMPLATE_NAME'] ?? null;
