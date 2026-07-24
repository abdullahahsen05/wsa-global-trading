"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { EmptyState, GhostButton, Panel } from "@/components/app/WorkspaceUI";
import { SearchField, SelectField } from "@/components/app/FormFields";

type DirectoryFilterOption = {
  label: string;
  value: string;
};

type DirectoryFilter = {
  key: string;
  label: string;
  options: DirectoryFilterOption[];
};

type DirectorySearchOverlayProps<T> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  items: T[];
  selectedId: string;
  onSelect: (id: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  filters?: DirectoryFilter[];
  emptyTitle: string;
  emptyDescription: string;
  getId: (item: T) => string;
  matches: (item: T, state: { query: string; filters: Record<string, string> }) => boolean;
  renderRow: (item: T, active: boolean) => ReactNode;
  renderPreview: (item: T) => ReactNode;
};

export function DirectorySearchOverlay<T>({
  open,
  onOpenChange,
  title,
  description,
  items,
  selectedId,
  onSelect,
  searchLabel,
  searchPlaceholder,
  filters = [],
  emptyTitle,
  emptyDescription,
  getId,
  matches,
  renderRow,
  renderPreview,
}: DirectorySearchOverlayProps<T>) {
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [filterValues, setFilterValues] = useState<Record<string, string>>(
    Object.fromEntries(filters.map((filter) => [filter.key, "ALL"])),
  );
  const pageSize = 10;

  const filteredItems = useMemo(
    () => items.filter((item) => matches(item, { query, filters: filterValues })),
    [items, matches, query, filterValues],
  );

  const totalItems = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const startIndex = (currentPageSafe - 1) * pageSize;
  const visibleItems = filteredItems.slice(startIndex, startIndex + pageSize);
  const activeItem = filteredItems.find((item) => getId(item) === selectedId) ?? filteredItems[0] ?? null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setCurrentPage(1);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[96vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[6px] border border-line bg-panel shadow-[0_24px_64px_rgba(0,0,0,0.5)] focus:outline-none">
          <div className="flex min-h-0 w-full flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">{searchLabel}</p>
                <Dialog.Title className="mt-2 text-lg font-semibold text-foreground">{title}</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close search"
                  className="grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted transition hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="grid min-h-0 max-h-[calc(90vh-92px)] flex-1 items-stretch gap-0 lg:grid-cols-[360px_minmax(0,1fr)]">
              <div className="flex min-h-0 flex-col border-r border-line p-5">
                <div className="grid gap-3">
                  <SearchField
                    label={searchLabel}
                    placeholder={searchPlaceholder}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setCurrentPage(1);
                    }}
                  />
                  {filters.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {filters.map((filter) => (
                        <SelectField
                          key={filter.key}
                          label={filter.label}
                          value={filterValues[filter.key] ?? "ALL"}
                          onChange={(event) => {
                            setFilterValues((current) => ({
                              ...current,
                              [filter.key]: event.target.value,
                            }));
                            setCurrentPage(1);
                          }}
                        >
                          {filter.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </SelectField>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 border-b border-line pb-4">
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted">
                    {totalItems === 0
                      ? "No matches"
                      : `${startIndex + 1}-${Math.min(startIndex + pageSize, totalItems)} of ${totalItems}`}
                  </p>
                  <div className="flex gap-2">
                    <GhostButton
                      type="button"
                      disabled={currentPageSafe <= 1}
                      onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    >
                      Prev
                    </GhostButton>
                    <GhostButton
                      type="button"
                      disabled={currentPageSafe >= totalPages}
                      onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    >
                      Next
                    </GhostButton>
                  </div>
                </div>

                <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                  {filteredItems.length === 0 ? (
                    <EmptyState title={emptyTitle} description={emptyDescription} />
                  ) : (
                    visibleItems.map((item) => {
                      const id = getId(item);
                      const active = id === (activeItem ? getId(activeItem) : selectedId);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => onSelect(id)}
                          className={`w-full rounded-[4px] border p-3 text-left transition ${
                            active
                              ? "border-accent/40 bg-accent/10"
                              : "border-line bg-background hover:border-accent/30"
                          }`}
                        >
                          {renderRow(item, active)}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="invisible-scrollbar min-h-0 overflow-y-auto p-5">
                {activeItem ? (
                  renderPreview(activeItem)
                ) : (
                  <Panel>
                    <EmptyState
                      title={emptyTitle}
                      description={emptyDescription}
                      icon={Search}
                    />
                  </Panel>
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
