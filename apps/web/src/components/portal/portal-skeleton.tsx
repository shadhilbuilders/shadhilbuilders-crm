// PortalPageSkeleton: the loading shape of /portal - record head, ladder, then
// ledger rows - so the page does not jump when data lands.
//
// REDESIGN (2026-11-09, second pass): it used to sketch a nested photo bezel,
// which matched the old card design. It now sketches the same ruled grid the
// real content uses. Pulse only (opacity), which reduced-motion users get as a
// static block.
export function PortalPageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your home" data-qa="portal-page-skeleton">
      <div className="portal-rule-b grid grid-cols-1 items-end gap-6 pt-7 pb-5 lg:grid-cols-12 lg:gap-5">
        <div className="space-y-3 lg:col-span-8">
          <div className="h-3.5 w-28 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          <div className="h-12 w-2/3 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none sm:h-16" />
          <div className="h-4 w-1/3 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
        </div>
        <div className="grid grid-cols-2 gap-6 border-t border-[var(--portal-hair)] pt-4 lg:col-span-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <div className="space-y-2">
            <div className="h-2.5 w-16 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
            <div className="h-4 w-20 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          </div>
          <div className="space-y-2">
            <div className="h-2.5 w-12 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
            <div className="h-4 w-16 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 pt-6 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-8">
          <div className="aspect-[4/3] w-full animate-pulse border border-[var(--portal-hair)] bg-[var(--portal-hair)] motion-reduce:animate-none sm:aspect-[2/1]" />
        </div>
        <div className="space-y-3 border-t-2 border-[var(--portal-hair)] pt-4 lg:col-span-4">
          <div className="h-2.5 w-20 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          <div className="h-4 w-full animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          <div className="h-4 w-4/5 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
        </div>
      </div>

      <div className="mt-10 space-y-0">
        <div className="portal-rule-b pb-2.5">
          <div className="h-5 w-36 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
        </div>
        {[0, 1].map((i) => (
          <div key={i} className="portal-hairline-b flex items-center gap-4 py-4">
            <div className="size-[4.5rem] shrink-0 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3.5 w-2/5 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
              <div className="h-2.5 w-1/5 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading your home...</span>
    </div>
  );
}
