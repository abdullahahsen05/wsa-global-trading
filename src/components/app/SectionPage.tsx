import { PageHeader } from "@/components/app/PageHeader";

export function SectionPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <section>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <div className="rounded-[4px] border border-line bg-panel p-5">
        {children ?? (
          <p className="text-sm text-muted">
            This route is scaffolded against the shared domain model and ready for the next
            implementation pass.
          </p>
        )}
      </div>
    </section>
  );
}
