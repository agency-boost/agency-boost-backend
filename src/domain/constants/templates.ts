/**
 * **A named template's bounds** (ADR-0115 §3; P13.2-T6, T7).
 *
 * The longest name a template may have — *New template*, *Rename*, *Import from another company* and
 * *Save as template* all take one. Declared once here and read by the DTOs (`named-template.dto.ts`);
 * the frontend declares one constant of its own, `TEMPLATE_NAME_MAX` in `src/lib/templates.ts`, which a
 * cross-repository spec pins to this file (P13.2's exit review: it had been written out four times).
 */
export const TEMPLATE = {
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 80,
} as const;
