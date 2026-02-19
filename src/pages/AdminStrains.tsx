import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { formatPrice } from '@/lib/currency';
import {
  Leaf, 
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Search,
  RefreshCw,
  Database,
  Cloud,
  Save,
  X,
  ImageIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import AdminLayout from '@/layout/AdminLayout';

interface Strain {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  type: string;
  thc_content: number;
  cbd_content: number;
  cbg_content: number;
  retail_price: number;
  availability: boolean;
  stock: number;
  image_url: string | null;
  brand_name: string | null;
  feelings: string[] | null;
  flavors: string[] | null;
  helps_with: string[] | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

const emptyStrain: Partial<Strain> = {
  sku: '',
  name: '',
  description: '',
  type: 'Hybrid',
  thc_content: 0,
  cbd_content: 0,
  cbg_content: 0,
  retail_price: 0,
  availability: true,
  stock: 100,
  image_url: '',
  brand_name: 'Dr. Green',
  feelings: [],
  flavors: [],
  helps_with: [],
  is_archived: false,
};

const AdminStrains = () => {
  const [strains, setStrains] = useState<Strain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingStrain, setEditingStrain] = useState<Partial<Strain> | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchStrains();
  }, []);

  const fetchStrains = async () => {
    try {
      const { data, error } = await supabase
        .from('strains')
        .select('*')
        .order('name');

      if (error) throw error;
      setStrains(data || []);
    } catch (error) {
      console.error('Error fetching strains:', error);
      toast({
        title: 'Error',
        description: 'Failed to load strains.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-strains');
      if (error) throw error;
      
      if (data?.success) {
        toast({
          title: 'Sync Complete',
          description: `Synced ${data.synced} cultivars from Dr Green API`,
        });
        fetchStrains();
      } else {
        throw new Error(data?.error || 'Sync failed');
      }
    } catch (error: any) {
      console.error('Sync error:', error);
      toast({
        title: 'Sync Failed',
        description: error.message || 'Failed to sync cultivars from API',
        variant: 'destructive',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSave = async () => {
    if (!editingStrain?.name || !editingStrain?.sku) {
      toast({
        title: 'Validation Error',
        description: 'Name and SKU are required.',
        variant: 'destructive',
      });
      return;
    }

    setIsSaving(true);
    try {
      const strainData = {
        sku: editingStrain.sku,
        name: editingStrain.name,
        description: editingStrain.description || null,
        type: editingStrain.type || 'Hybrid',
        thc_content: editingStrain.thc_content || 0,
        cbd_content: editingStrain.cbd_content || 0,
        cbg_content: editingStrain.cbg_content || 0,
        retail_price: editingStrain.retail_price || 0,
        availability: editingStrain.availability ?? true,
        stock: editingStrain.stock || 0,
        image_url: editingStrain.image_url || null,
        brand_name: editingStrain.brand_name || 'Dr. Green',
        feelings: editingStrain.feelings || [],
        flavors: editingStrain.flavors || [],
        helps_with: editingStrain.helps_with || [],
        is_archived: editingStrain.is_archived ?? false,
      };

      if (editingStrain.id) {
        // Update existing
        const { error } = await supabase
          .from('strains')
          .update(strainData)
          .eq('id', editingStrain.id);
        if (error) throw error;
        toast({ title: 'Cultivar Updated', description: `${editingStrain.name} has been updated.` });
      } else {
        // Create new
        const { error } = await supabase
          .from('strains')
          .insert(strainData);
        if (error) throw error;
        toast({ title: 'Cultivar Created', description: `${editingStrain.name} has been created.` });
      }

      setIsDialogOpen(false);
      setEditingStrain(null);
      fetchStrains();
    } catch (error: any) {
      console.error('Save error:', error);
      toast({
        title: 'Save Failed',
        description: error.message || 'Failed to save cultivar.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from('strains')
        .delete()
        .eq('id', id);
      if (error) throw error;
      
      toast({ title: 'Cultivar Deleted', description: 'The cultivar has been removed.' });
      fetchStrains();
    } catch (error: any) {
      console.error('Delete error:', error);
      toast({
        title: 'Delete Failed',
        description: error.message || 'Failed to delete cultivar.',
        variant: 'destructive',
      });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleArchiveToggle = async (strain: Strain) => {
    try {
      const { error } = await supabase
        .from('strains')
        .update({ is_archived: !strain.is_archived })
        .eq('id', strain.id);
      if (error) throw error;
      
      toast({
        title: strain.is_archived ? 'Cultivar Restored' : 'Cultivar Archived',
        description: `${strain.name} has been ${strain.is_archived ? 'restored' : 'archived'}.`,
      });
      fetchStrains();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to update strain.',
        variant: 'destructive',
      });
    }
  };

  const filteredStrains = strains.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.sku.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AdminLayout 
      title="Cultivar Management" 
      description={`Manage locally cached cultivar data • ${strains.length} cultivars`}
    >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 mb-6">
          <Button
            variant="outline"
            onClick={handleSync}
            disabled={isSyncing}
          >
            {isSyncing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Cloud className="mr-2 h-4 w-4" />
            )}
            Sync from API
          </Button>
          <Button onClick={() => {
            setEditingStrain({ ...emptyStrain });
            setIsDialogOpen(true);
          }}>
            <Plus className="mr-2 h-4 w-4" />
            Add Cultivar
          </Button>
        </div>

        {/* Search */}
        <Card className="mb-6 bg-card/50 backdrop-blur-sm border-[hsl(var(--admin-soft-green))]/30">
          <CardContent className="pt-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search cultivars by name or SKU..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </CardContent>
        </Card>

        {/* Strains Table */}
        <Card className="bg-card/50 backdrop-blur-sm border-[hsl(var(--admin-soft-green))]/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Cultivar Catalog
            </CardTitle>
            <CardDescription>
              {filteredStrains.length} cultivar{filteredStrains.length !== 1 ? 's' : ''} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Image</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>THC</TableHead>
                      <TableHead>CBD</TableHead>
                      <TableHead>Price (EUR)</TableHead>
                      <TableHead>Stock</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStrains.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center py-12">
                          <Leaf className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50" />
                          <p className="text-muted-foreground">No cultivars found</p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredStrains.map((strain) => (
                        <TableRow key={strain.id} className={strain.is_archived ? 'opacity-50' : ''}>
                          <TableCell>
                            {strain.image_url ? (
                              <img
                                src={strain.image_url}
                                alt={strain.name}
                                className="w-12 h-12 object-cover rounded-lg"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
                                <ImageIcon className="h-5 w-5 text-muted-foreground" />
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <div>
                              <p className="font-medium">{strain.name}</p>
                              <p className="text-xs text-muted-foreground">{strain.sku}</p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{strain.type}</Badge>
                          </TableCell>
                          <TableCell>{strain.thc_content}%</TableCell>
                          <TableCell>{strain.cbd_content}%</TableCell>
                          <TableCell>{formatPrice(strain.retail_price, 'PT')}</TableCell>
                          <TableCell>{strain.stock}</TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              {strain.is_archived ? (
                                <Badge variant="secondary">Archived</Badge>
                              ) : strain.availability ? (
                                <Badge variant="default" className="bg-[hsl(var(--admin-fir))]">Available</Badge>
                              ) : (
                                <Badge variant="destructive">Unavailable</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditingStrain(strain);
                                  setIsDialogOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleArchiveToggle(strain)}
                              >
                                {strain.is_archived ? (
                                  <RefreshCw className="h-4 w-4" />
                                ) : (
                                  <X className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDeleteConfirm(strain.id)}
                                className="text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Edit/Create Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingStrain?.id ? 'Edit Cultivar' : 'Add New Cultivar'}
            </DialogTitle>
          </DialogHeader>
          {editingStrain && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={editingStrain.name || ''}
                    onChange={(e) => setEditingStrain({ ...editingStrain, name: e.target.value })}
                    placeholder="Cultivar name"
                  />
                </div>
                <div className="space-y-2">
                  <Label>SKU *</Label>
                  <Input
                    value={editingStrain.sku || ''}
                    onChange={(e) => setEditingStrain({ ...editingStrain, sku: e.target.value })}
                    placeholder="Unique SKU"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={editingStrain.description || ''}
                  onChange={(e) => setEditingStrain({ ...editingStrain, description: e.target.value })}
                  placeholder="Cultivar description..."
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select
                    value={editingStrain.type || 'Hybrid'}
                    onValueChange={(v) => setEditingStrain({ ...editingStrain, type: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Sativa">Sativa</SelectItem>
                      <SelectItem value="Indica">Indica</SelectItem>
                      <SelectItem value="Hybrid">Hybrid</SelectItem>
                      <SelectItem value="CBD">CBD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Brand</Label>
                  <Input
                    value={editingStrain.brand_name || ''}
                    onChange={(e) => setEditingStrain({ ...editingStrain, brand_name: e.target.value })}
                    placeholder="Dr. Green"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>THC %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={editingStrain.thc_content || 0}
                    onChange={(e) => setEditingStrain({ ...editingStrain, thc_content: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>CBD %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={editingStrain.cbd_content || 0}
                    onChange={(e) => setEditingStrain({ ...editingStrain, cbd_content: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>CBG %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={editingStrain.cbg_content || 0}
                    onChange={(e) => setEditingStrain({ ...editingStrain, cbg_content: parseFloat(e.target.value) || 0 })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Retail Price (€)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={editingStrain.retail_price || 0}
                    onChange={(e) => setEditingStrain({ ...editingStrain, retail_price: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Stock</Label>
                  <Input
                    type="number"
                    value={editingStrain.stock || 0}
                    onChange={(e) => setEditingStrain({ ...editingStrain, stock: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Image URL</Label>
                <Input
                  value={editingStrain.image_url || ''}
                  onChange={(e) => setEditingStrain({ ...editingStrain, image_url: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="space-y-2">
                <Label>Effects/Feelings (comma separated)</Label>
                <Input
                  value={(editingStrain.feelings || []).join(', ')}
                  onChange={(e) => setEditingStrain({ 
                    ...editingStrain, 
                    feelings: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                  })}
                  placeholder="Relaxed, Happy, Euphoric"
                />
              </div>

              <div className="space-y-2">
                <Label>Flavors/Terpenes (comma separated)</Label>
                <Input
                  value={(editingStrain.flavors || []).join(', ')}
                  onChange={(e) => setEditingStrain({ 
                    ...editingStrain, 
                    flavors: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                  })}
                  placeholder="Citrus, Pine, Earthy"
                />
              </div>

              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={editingStrain.availability ?? true}
                    onCheckedChange={(v) => setEditingStrain({ ...editingStrain, availability: v })}
                  />
                  <Label>Available</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={editingStrain.is_archived ?? false}
                    onCheckedChange={(v) => setEditingStrain({ ...editingStrain, is_archived: v })}
                  />
                  <Label>Archived</Label>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Cultivar?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The cultivar will be permanently removed from the database.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
};

export default AdminStrains;
