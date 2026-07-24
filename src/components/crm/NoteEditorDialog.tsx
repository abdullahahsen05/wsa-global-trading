"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { GhostButton, PrimaryButton } from "@/components/app/WorkspaceUI";
import { TextAreaField, TextField } from "@/components/app/FormFields";

type NoteEditorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedName: string;
  onSave: (note: string) => void;
};

export function NoteEditorDialog({ open, onOpenChange, selectedName, onSave }: NoteEditorDialogProps) {
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);

    window.setTimeout(() => {
      setIsSaving(false);
      onOpenChange(false);
      onSave(`Communication note saved for ${selectedName}.`);
    }, 900);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
        <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-5 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-foreground">Add communication note</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-6 text-muted">
            Save a note to the selected profile&apos;s communication history.
          </Dialog.Description>
          <form className="mt-5 grid gap-4" onSubmit={handleSave}>
            <TextField label="Profile" defaultValue={selectedName} readOnly />
            <TextAreaField label="Note" defaultValue="Follow up on account status, risk posture, and next review date." />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-sm text-muted">This updates the mock CRM activity feed only.</p>
              <div className="flex gap-3">
                <Dialog.Close asChild>
                  <GhostButton type="button">Cancel</GhostButton>
                </Dialog.Close>
                <PrimaryButton type="submit" disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save note"}
                </PrimaryButton>
              </div>
            </div>
          </form>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close dialog"
              className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
