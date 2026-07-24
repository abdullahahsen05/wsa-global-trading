import Link from "next/link";
import { EmptyState } from "@/components/app/WorkspaceUI";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1440px]">
      <EmptyState
        title="Account not found"
        description="The selected trading account is unavailable or has been removed from the mock dataset."
        action={
          <Link
            href="/accounts"
            className="rounded-[4px] bg-accent px-6 py-3 text-sm font-semibold text-background transition"
          >
            Back to accounts
          </Link>
        }
      />
    </div>
  );
}
