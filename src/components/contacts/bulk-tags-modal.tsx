'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { Tag } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

interface BulkTagsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactIds: string[];
  onSaved: () => void;
}

export function BulkTagsModal({
  open,
  onOpenChange,
  contactIds,
  onSaved,
}: BulkTagsModalProps) {
  const supabase = createClient();
  const { accountId } = useAuth();
  
  const [tags, setTags] = useState<Tag[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [saving, setSaving] = useState(false);
  
  const [tagsToAdd, setTagsToAdd] = useState<Set<string>>(new Set());
  const [tagsToRemove, setTagsToRemove] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && accountId) {
      setTagsToAdd(new Set());
      setTagsToRemove(new Set());
      fetchTags();
    }
  }, [open, accountId]);

  async function fetchTags() {
    setLoadingTags(true);
    const { data } = await supabase
      .from('tags')
      .select('*')
      .eq('account_id', accountId)
      .order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function toggleAdd(tagId: string) {
    setTagsToAdd((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
        setTagsToRemove((r) => {
          const nr = new Set(r);
          nr.delete(tagId);
          return nr;
        });
      }
      return next;
    });
  }

  function toggleRemove(tagId: string) {
    setTagsToRemove((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
        setTagsToAdd((a) => {
          const na = new Set(a);
          na.delete(tagId);
          return na;
        });
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (tagsToAdd.size === 0 && tagsToRemove.size === 0) {
      onOpenChange(false);
      return;
    }

    setSaving(true);
    try {
      if (tagsToRemove.size > 0) {
        const { error } = await supabase
          .from('contact_tags')
          .delete()
          .in('contact_id', contactIds)
          .in('tag_id', Array.from(tagsToRemove));
        
        if (error) throw error;
      }

      if (tagsToAdd.size > 0) {
        const rows = [];
        for (const cid of contactIds) {
          for (const tid of Array.from(tagsToAdd)) {
            rows.push({ contact_id: cid, tag_id: tid });
          }
        }
        
        // Chunk inserts to avoid query limits on huge bulk actions
        const chunkSize = 1000;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const { error } = await supabase
            .from('contact_tags')
            .upsert(chunk, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
          if (error) throw error;
        }
      }

      toast.success('Tags updated successfully');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error((err instanceof Error ? err.message : String(err)) || 'Failed to update tags');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Tags</DialogTitle>
          <DialogDescription>
            Assign or remove tags for {contactIds.length} selected contacts.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-3">
            <Label>Add Tags</Label>
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border p-3 bg-muted/20">
              {loadingTags ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="size-3 animate-spin" /> Loading tags...
                </div>
              ) : tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tags available.</p>
              ) : (
                tags.map((tag) => {
                  const selected = tagsToAdd.has(tag.id);
                  return (
                    <button
                      key={'add-' + tag.id}
                      type="button"
                      onClick={() => toggleAdd(tag.id)}
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                        selected
                          ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: tag.color + '20',
                        color: tag.color,
                        borderColor: tag.color,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })
              )}
            </div>
            <p className="text-xs text-muted-foreground">These tags will be added to all selected contacts.</p>
          </div>

          <div className="space-y-3">
            <Label>Remove Tags</Label>
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border p-3 bg-muted/20">
              {loadingTags ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="size-3 animate-spin" /> Loading tags...
                </div>
              ) : tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tags available.</p>
              ) : (
                tags.map((tag) => {
                  const selected = tagsToRemove.has(tag.id);
                  return (
                    <button
                      key={'remove-' + tag.id}
                      type="button"
                      onClick={() => toggleRemove(tag.id)}
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                        selected
                          ? 'ring-2 ring-destructive ring-offset-1 ring-offset-border'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: tag.color + '20',
                        color: tag.color,
                        borderColor: tag.color,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })
              )}
            </div>
            <p className="text-xs text-muted-foreground">These tags will be removed from all selected contacts.</p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin mr-2" />}
              Apply Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
