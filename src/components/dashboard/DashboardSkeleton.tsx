/**
 * What the trader dashboard shows while it does not know the platform access or the account list yet: the boxes the
 * finished page has, quietly pulsing. The page has its shape from the first paint, nothing jumps when the figures
 * arrive, and no "$0.00" is shown for numbers that simply have not come in. (Markup only - no hooks, so the server
 * renders it into the HTML the browser gets first.)
 */
function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[4px] bg-panel-strong/70 ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the dashboard">
      <section className="mb-4 overflow-hidden border border-line bg-panel">
        <div className="grid lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2fr)]">
          <div className="border-b border-line px-4 py-3 lg:border-b-0 lg:border-r">
            <Block className="h-3 w-32" />
            <Block className="mt-3 h-6 w-44 max-w-full" />
          </div>
          <div className="grid sm:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="border-b border-line px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
                <Block className="h-3 w-16" />
                <Block className="mt-3 h-5 w-28 max-w-full" />
              </div>
            ))}
          </div>
        </div>
      </section>
      <div className="grid overflow-hidden rounded-[4px] border border-line bg-panel xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="border-b border-line px-5 py-4 last:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0"
          >
            <Block className="h-3 w-20" />
            <Block className="mt-4 h-8 w-40 max-w-full" />
            <Block className="mt-3 h-4 w-56 max-w-full" />
            <Block className="mt-6 h-4 w-28" />
          </div>
        ))}
      </div>
      <Block className="mt-4 h-[84px]" />
      <Block className="mt-4 h-44" />
      <Block className="mt-4 h-[420px]" />
    </div>
  );
}
