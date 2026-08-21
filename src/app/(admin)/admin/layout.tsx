import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/auth/session";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireAdmin();
    return children;
  } catch (error) {
    if (error instanceof AuthError) {
      redirect("/dashboard");
    }
    throw error;
  }
}
