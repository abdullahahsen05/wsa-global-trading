import type { CrmNoteDto } from "@/lib/domain/types";

export function NotesTimeline({ notes }: { notes: CrmNoteDto[] }) {
  return (
    <div className="space-y-3">
      {notes.map((note) => (
        <div key={note.id} className="rounded-[4px] border border-line bg-background p-4">
          <p className="text-sm text-foreground">{note.note}</p>
          <p className="mt-2 text-xs text-muted">
            {note.authorName} · {new Date(note.createdAt).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}
