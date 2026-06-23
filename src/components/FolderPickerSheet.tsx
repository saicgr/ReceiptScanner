/**
 * FolderPickerSheet — a reusable modal for choosing one or more folders.
 *
 * Folders are shown as a flat, indented tree (ancestry expressed by indentation)
 * so the user can target any level (Client -> Project -> Trip) without drilling.
 * Multi-select reflects that a receipt's folder membership is MANY-TO-MANY.
 * Includes an inline "New folder" affordance so the user never has to leave the
 * flow to create a destination.
 */
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import {
  Button,
  Icon,
  IconButton,
  Row,
  Text,
  TextField,
  useTheme,
} from '@/components/ui';
import * as DB from '@/db';
import type { Folder } from '@/types';

interface TreeRow {
  folder: Folder;
  depth: number;
}

/** Flatten the folder forest into depth-annotated rows (stable, name-sorted). */
function buildTree(folders: Folder[]): TreeRow[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const list = byParent.get(f.parent_id) ?? [];
    list.push(f);
    byParent.set(f.parent_id, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  const out: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of byParent.get(parentId) ?? []) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function FolderPickerSheet({
  visible,
  title = 'Add to folders',
  multi = true,
  selected,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title?: string;
  multi?: boolean;
  selected: string[];
  onConfirm: (folderIds: string[]) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setFolders(await DB.Folders.listFolders());
  }, []);

  useEffect(() => {
    if (visible) {
      setPicked(new Set(selected));
      setCreating(false);
      setNewName('');
      load();
    }
  }, [visible, selected, load]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = multi ? new Set(prev) : new Set<string>();
      if (prev.has(id) && multi) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    const folder = await DB.Folders.createFolder({ name });
    setNewName('');
    setCreating(false);
    await load();
    setPicked((prev) => new Set(prev).add(folder.id));
  };

  const tree = buildTree(folders);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: t.colors.bg,
            borderTopLeftRadius: t.radius.xl,
            borderTopRightRadius: t.radius.xl,
            paddingTop: t.spacing.md,
            paddingHorizontal: t.spacing.lg,
            paddingBottom: t.spacing.xl,
            maxHeight: '85%',
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={{ alignItems: 'center', paddingBottom: t.spacing.sm }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />
          </View>
          <Row justify="space-between" align="center" style={{ marginBottom: t.spacing.md }}>
            <Text variant="subheading">{title}</Text>
            <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" />
          </Row>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
            {tree.length === 0 ? (
              <Text variant="body" color={t.colors.textMuted} style={{ paddingVertical: t.spacing.md }}>
                No folders yet. Create one below.
              </Text>
            ) : (
              tree.map(({ folder, depth }) => {
                const active = picked.has(folder.id);
                return (
                  <Pressable
                    key={folder.id}
                    onPress={() => toggle(folder.id)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: t.spacing.sm,
                      paddingVertical: t.spacing.md,
                      paddingLeft: depth * 18,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Icon name="folder" size={18} color={folder.color} />
                    <Text variant="body" weight={active ? '700' : '400'} style={{ flex: 1 }}>
                      {folder.name}
                    </Text>
                    <Icon
                      name={active ? (multi ? 'checkbox' : 'checkmark-circle') : 'square-outline'}
                      size={20}
                      color={active ? t.colors.brand : t.colors.textMuted}
                    />
                  </Pressable>
                );
              })
            )}
          </ScrollView>

          {creating ? (
            <Row gap={t.spacing.sm} align="center" style={{ marginTop: t.spacing.sm }}>
              <View style={{ flex: 1 }}>
                <TextField
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="New folder name"
                  autoFocus
                />
              </View>
              <IconButton icon="checkmark" color={t.colors.brand} onPress={addFolder} accessibilityLabel="Create folder" />
            </Row>
          ) : (
            <Button
              title="New folder"
              icon="add"
              variant="ghost"
              style={{ marginTop: t.spacing.sm }}
              onPress={() => setCreating(true)}
            />
          )}

          <Button
            title="Done"
            icon="checkmark"
            style={{ marginTop: t.spacing.md }}
            onPress={() => onConfirm([...picked])}
            fullWidth
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
