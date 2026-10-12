import { z } from "zod";
export const controlInspectionSchema = z.object({
  code: z.literal("CONTROL_INSPECTED"), fieldId: z.string().min(1).max(140),
  component: z.enum(["native_or_custom", "my97_calendar", "legacy_area"]), readOnly: z.boolean(),
  optionLabels: z.array(z.string().min(1).max(180)).max(300),
  optionsObserved: z.boolean().default(false),
  documentReady: z.boolean(), areaApiAvailable: z.boolean(), calendarApiAvailable: z.boolean(),
  areaContextReady: z.boolean().default(false),
}).strict();
