// Internal WhatsApp notification env config.
//
// The `internal_enquiry_notification` template + the ops test recipient are
// read from env so they can be swapped without a code change. These are
// DISTINCT from the lead-chat template envs (WA_TEMPLATE_CHAT_REPLY etc.).
export const WA_RECIPIENT = process.env['WA_RECIPIENT'] ?? null;
export const WA_INTERNAL_TEMPLATE_NAME =
  process.env['WA_INTERNAL_TEMPLATE_NAME'] ?? null;
