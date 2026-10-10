// The text the Tools tab writes for a model to read: transfer instructions, funnel guidance, usage
// guidance. An agent on questions and rules has no model to read it and does not draw these fields,
// so its Tools save writes them as stored, and an edit made before the switch stays pending for a
// switch back, like the instructions and the chat model on General.
export interface ToolGuidance {
  handoffInstructions: string;
  kanbanInstructions: string;
  customAttributeInstructions: string;
  labelInstructions: string;
  updateKanbanTaskInstructions: string;
}

// What a Tools save writes: the form's guidance, or the stored one when `stored` is given (the
// decisions engine).
export function guidanceToSave(
  form: ToolGuidance,
  stored: ToolGuidance | null,
): ToolGuidance {
  return stored ?? form;
}

// Whether the form holds guidance a save of this engine does not write.
export function guidanceDraftHidden(
  form: ToolGuidance,
  stored: ToolGuidance | null,
): boolean {
  return stored !== null && JSON.stringify(form) !== JSON.stringify(stored);
}
