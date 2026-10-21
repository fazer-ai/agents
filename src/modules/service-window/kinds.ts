// WHICH PROACTIVE SEND this is. Each kind may name its own template; a kind without one uses the
// agent's default (`templateName` and its params), which is what every kind used before kinds existed.
// Its own file, free of imports, because the settings schema and the editor read it too.
export const PROACTIVE_KINDS = [
  "followup",
  "snoozed_followup",
  "appointment_reminder",
  "inbound_event",
  "document_approval",
  "channel_redirect",
] as const;
export type ProactiveKind = (typeof PROACTIVE_KINDS)[number];

// The appointment's placeholders, Portuguese and English spellings like the contact's. Only a
// reminder has them; any other kind refuses them at save.
export const APPOINTMENT_VARS = [
  "data_agendamento",
  "appointment_date",
  "hora_agendamento",
  "appointment_time",
  "dia_semana_agendamento",
  "appointment_weekday",
  "agenda",
  "calendar_name",
] as const;
