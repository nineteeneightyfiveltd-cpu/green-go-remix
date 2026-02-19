import { useState } from "react";
import AdminLayout from "@/layout/AdminLayout";
import { AdminClientManager } from "@/components/admin/AdminClientManager";
import { AdminClientCreator } from "@/components/admin/AdminClientCreator";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Plus, ChevronDown, UserPlus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

const AdminClients = () => {
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const { toast } = useToast();

  const handleProvisionUsers = async () => {
    setProvisioning(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-provision-users");
      if (error) throw error;
      toast({
        title: "Provisioning Complete",
        description: `Created: ${data.created} · Skipped: ${data.skipped} · Failed: ${data.failed}`,
      });
    } catch (err) {
      toast({
        title: "Provisioning Failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <AdminLayout
      title="Client Management"
      description="Create, manage, and sync client records with Dr. Green DApp"
    >
      <div className="space-y-6">
        <div className="flex gap-3">
          <Collapsible open={creatorOpen} onOpenChange={setCreatorOpen} className="flex-1">
            <CollapsibleTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-between border-[hsl(var(--admin-soft-green))]/30 hover:bg-[hsl(var(--admin-parchment))]/50 dark:hover:bg-card"
              >
                <span className="flex items-center gap-2">
                  <Plus className="w-4 h-4" />
                  Create New Client
                </span>
                <ChevronDown className={cn("w-4 h-4 transition-transform", creatorOpen && "rotate-180")} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3">
              <AdminClientCreator />
            </CollapsibleContent>
          </Collapsible>

          <Button
            variant="outline"
            onClick={handleProvisionUsers}
            disabled={provisioning}
            className="shrink-0 border-[hsl(var(--admin-soft-green))]/30 hover:bg-[hsl(var(--admin-parchment))]/50 dark:hover:bg-card"
          >
            {provisioning ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <UserPlus className="w-4 h-4 mr-2" />
            )}
            Provision All Users
          </Button>
        </div>

        <AdminClientManager />
      </div>
    </AdminLayout>
  );
};

export default AdminClients;
