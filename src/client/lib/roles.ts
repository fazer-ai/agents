// Re-export of the shared, pure role helpers (@/lib/roles) so client code keeps a
// stable `@/client/lib/roles` import path. The shared module has no runtime deps, so it
// bundles into the browser cleanly.

export type { UserRole as ClientRole } from "@/../generated/prisma/client";
export { canEditAgentsRole, isAdminRole, roleAtLeast } from "@/lib/roles";
