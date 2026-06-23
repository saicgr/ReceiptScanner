/**
 * FolderScreen — the file-manager view of a single folder.
 *
 * Shows the folder's nested SUBFOLDERS (Client -> Project -> Trip) followed by
 * the receipts LABELLED directly into it, with a breadcrumb back to the root.
 * Long-press a receipt to enter multi-select for bulk MOVE (relabel into another
 * folder), bulk REMOVE-from-folder (the receipt itself is never deleted — only
 * its label here), and bulk DELETE. The folder can be exported as a point-in-time
 * BUNDLE (CSV + HTML report) to the OS share sheet — entirely on-device.
 *
 * Because folder membership is a many-to-many LABEL over one underlying receipt,
 * nothing here ever duplicates a record, so totals/stats can't double-count.
 */
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import {
  Screen,
  Card,
  Text,
  Row,
  SectionHeader,
  Chip,
  EmptyState,
  IconButton,
  Button,
  Icon,
  TextField,
  LoadingOverlay,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { FolderPickerSheet } from '@/components/FolderPickerSheet';
import * as DB from '@/db';
import { deleteReceiptCascade } from '@/services/receiptService';
import { exportFolderBundle } from '@/services/folderExport';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import type { Folder, FolderNode, Receipt } from '@/types';

export default function FolderScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [folder, setFolder] = useState<Folder | null>(null);
  const [path, setPath] = useState<Folder[]>([]);
  const [subfolders, setSubfolders] = useState<FolderNode[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Multi-select.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [creatingSub, setCreatingSub] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setLoaded(true);
      return;
    }
    const [f, p, subs, recs] = await Promise.all([
      DB.Folders.getFolder(id),
      DB.Folders.folderPath(id),
      DB.Folders.listFolderNodes(id),
      DB.Folders.listReceiptsInFolder(id, false),
    ]);
    setFolder(f);
    setPath(p);
    setSubfolders(subs);
    setReceipts(recs);
    setLoaded(true);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const toggleSelect = (rid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid);
      else next.add(rid);
      return next;
    });
  };
  const openReceipt = (rid: string) => {
    if (selectMode) {
      toggleSelect(rid);
      return;
    }
    router.push({ pathname: '/receipt/[id]', params: { id: rid } });
  };

  // ---- bulk actions ----
  const runMove = async (targetFolderIds: string[]) => {
    setMovePickerOpen(false);
    const target = targetFolderIds[0];
    if (!target || !id) return;
    setBusy('Moving…');
    try {
      await DB.Folders.moveReceiptsToFolder([...selected], target, id);
    } finally {
      setBusy(null);
      exitSelect();
      load();
    }
  };

  const runRemove = () => {
    if (!id || selected.size === 0) return;
    Alert.alert(
      'Remove from folder?',
      `Remove ${selected.size} receipt${selected.size === 1 ? '' : 's'} from this folder? The receipt${selected.size === 1 ? '' : 's'} stay in your library — only the folder label is removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          onPress: async () => {
            setBusy('Removing…');
            try {
              for (const rid of selected) {
                await DB.Folders.removeReceiptFromFolder(rid, id);
              }
            } finally {
              setBusy(null);
              exitSelect();
              load();
            }
          },
        },
      ],
    );
  };

  const runDelete = () => {
    if (selected.size === 0) return;
    Alert.alert(
      'Delete receipts?',
      `Permanently delete ${selected.size} receipt${selected.size === 1 ? '' : 's'} from your entire library? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy('Deleting…');
            try {
              for (const rid of selected) await deleteReceiptCascade(rid);
            } finally {
              setBusy(null);
              exitSelect();
              load();
            }
          },
        },
      ],
    );
  };

  const addSubfolder = () => {
    setCreatingSub(true);
  };

  const onPickedSubfolderName = async (name: string) => {
    setCreatingSub(false);
    if (!name.trim() || !id) return;
    await DB.Folders.createFolder({ name: name.trim(), parent_id: id });
    load();
  };

  const runExport = async () => {
    if (!settings.is_unlocked) {
      Alert.alert(
        'Unlock required',
        'Folder export is part of the one-time ReceiptSnap unlock — no subscriptions, no ads.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Unlock', onPress: () => router.push('/paywall') },
        ],
      );
      return;
    }
    setBusy('Building bundle…');
    try {
      await exportFolderBundle(id!, { includeSubfolders: true });
    } catch (e: any) {
      if (String(e?.message) === 'empty-folder') {
        Alert.alert('Nothing to export', 'This folder (and its subfolders) has no receipts yet.');
      } else {
        Alert.alert('Export failed', 'Could not build the folder bundle. Please try again.');
      }
    } finally {
      setBusy(null);
    }
  };

  const renameFolder = () => {
    if (!folder) return;
    Alert.prompt?.(
      'Rename folder',
      undefined,
      async (text) => {
        if (text?.trim()) {
          await DB.Folders.updateFolder(folder.id, { name: text.trim() });
          load();
        }
      },
      'plain-text',
      folder.name,
    );
  };

  return (
    <Screen scroll edges={['top']}>
      {/* Header / breadcrumb + actions */}
      {selectMode ? (
        <Row justify="space-between" align="center">
          <Row gap={t.spacing.sm} align="center">
            <IconButton icon="close" onPress={exitSelect} accessibilityLabel="Cancel selection" />
            <Text variant="heading">{selected.size} selected</Text>
          </Row>
          <Row gap={t.spacing.sm}>
            <IconButton icon="folder-open-outline" onPress={() => setMovePickerOpen(true)} accessibilityLabel="Move to folder" />
            <IconButton icon="remove-circle-outline" onPress={runRemove} accessibilityLabel="Remove from folder" />
            <IconButton icon="trash-outline" color={t.colors.danger} onPress={runDelete} accessibilityLabel="Delete receipts" />
          </Row>
        </Row>
      ) : (
        <Row justify="space-between" align="center">
          <Row gap={t.spacing.sm} align="center" style={{ flex: 1 }}>
            <IconButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Back" />
            <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
              {folder?.name ?? 'Folder'}
            </Text>
          </Row>
          <Row gap={t.spacing.xs}>
            <IconButton icon="create-outline" onPress={renameFolder} accessibilityLabel="Rename folder" />
            <IconButton icon="share-outline" onPress={runExport} accessibilityLabel="Export folder bundle" />
          </Row>
        </Row>
      )}

      {/* Breadcrumb */}
      {path.length > 1 ? (
        <Row gap={4} wrap align="center" style={{ marginTop: t.spacing.sm }}>
          {path.map((p, i) => (
            <Row key={p.id} gap={4} align="center">
              {i > 0 ? <Icon name="chevron-forward" size={12} color={t.colors.textMuted} /> : null}
              <Pressable onPress={() => (i === path.length - 1 ? undefined : router.replace({ pathname: '/folder/[id]', params: { id: p.id } }))}>
                <Text variant="caption" color={i === path.length - 1 ? t.colors.text : t.colors.textMuted} weight={i === path.length - 1 ? '700' : '400'}>
                  {p.name}
                </Text>
              </Pressable>
            </Row>
          ))}
        </Row>
      ) : null}

      {/* Subfolders */}
      <Row justify="space-between" align="center" style={{ marginTop: t.spacing.md }}>
        <SectionHeader title={`Subfolders · ${subfolders.length}`} />
      </Row>
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        {subfolders.map((f, i) => (
          <FolderRow key={f.id} folder={f} first={i === 0} onPress={() => router.push({ pathname: '/folder/[id]', params: { id: f.id } })} />
        ))}
        <Pressable
          onPress={addSubfolder}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.spacing.md,
            paddingVertical: t.spacing.md,
            borderTopWidth: subfolders.length ? 1 : 0,
            borderTopColor: t.colors.border,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="add-circle-outline" size={22} color={t.colors.brand} />
          <Text variant="body" color={t.colors.brand} weight="600">New subfolder</Text>
        </Pressable>
      </Card>

      {/* Receipts in this folder */}
      <SectionHeader title={`Receipts · ${receipts.length}`} />
      {loaded && receipts.length === 0 ? (
        <EmptyState
          icon="documents-outline"
          title="No receipts here yet"
          message="Open a receipt and use “Add to folders”, or move receipts in from the multi-select bar."
        />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
          {receipts.map((r, i) => (
            <ReceiptRow
              key={r.id}
              receipt={r}
              first={i === 0}
              selectMode={selectMode}
              selected={selected.has(r.id)}
              dateFormat={settings.date_format}
              onPress={() => openReceipt(r.id)}
              onLongPress={() => { setSelectMode(true); setSelected(new Set([r.id])); }}
            />
          ))}
        </Card>
      )}

      {receipts.length > 0 && !selectMode ? (
        <Button
          title="Export this folder"
          icon="download-outline"
          variant="secondary"
          style={{ marginTop: t.spacing.lg }}
          onPress={runExport}
        />
      ) : null}

      <FolderPickerSheet
        visible={movePickerOpen}
        title="Move to folder"
        multi={false}
        selected={[]}
        onConfirm={runMove}
        onClose={() => setMovePickerOpen(false)}
      />

      {/* Reuse the picker's inline create by opening a tiny prompt-style sheet. */}
      <NewSubfolderPrompt visible={creatingSub} onCancel={() => setCreatingSub(false)} onCreate={onPickedSubfolderName} />

      <LoadingOverlay visible={busy !== null} message={busy ?? undefined} />
    </Screen>
  );
}

function FolderRow({ folder, first, onPress }: { folder: FolderNode; first: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingVertical: t.spacing.md,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.colors.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 36, height: 36, borderRadius: t.radius.md, backgroundColor: folder.color + '22', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="folder" size={18} color={folder.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="body" weight="600">{folder.name}</Text>
        <Text variant="caption" color={t.colors.textMuted}>
          {folder.childCount} folder{folder.childCount === 1 ? '' : 's'} · {folder.receiptCount} receipt{folder.receiptCount === 1 ? '' : 's'}
        </Text>
      </View>
      <Icon name="chevron-forward" size={18} color={t.colors.textMuted} />
    </Pressable>
  );
}

function ReceiptRow({
  receipt,
  first,
  selectMode,
  selected,
  dateFormat,
  onPress,
  onLongPress,
}: {
  receipt: Receipt;
  first: boolean;
  selectMode: boolean;
  selected: boolean;
  dateFormat: string;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingVertical: t.spacing.md,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.colors.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {selectMode ? (
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={selected ? t.colors.brand : t.colors.textMuted} />
        </View>
      ) : receipt.original_image_uri ? (
        <Image source={{ uri: receipt.original_image_uri }} style={{ width: 44, height: 44, borderRadius: t.radius.md }} contentFit="cover" />
      ) : (
        <View style={{ width: 44, height: 44, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="receipt-outline" size={20} color={t.colors.textMuted} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text variant="body" weight="600" numberOfLines={1}>{receipt.vendor || 'Untitled receipt'}</Text>
        <Text variant="caption" color={t.colors.textMuted}>{formatDate(receipt.date, dateFormat) || 'No date'}</Text>
      </View>
      <Text variant="body" weight="600">{formatMoney(receipt.total, receipt.currency)}</Text>
    </Pressable>
  );
}

/** Minimal create prompt that works on all platforms (Alert.prompt is iOS-only). */
function NewSubfolderPrompt({ visible, onCancel, onCreate }: { visible: boolean; onCancel: () => void; onCreate: (name: string) => void }) {
  const t = useTheme();
  const [name, setName] = useState('');
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        style={{ flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: t.spacing.lg }}
      >
        <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%' }}>
          <Card style={{ width: '100%' }}>
            <Text variant="subheading" style={{ marginBottom: t.spacing.md }}>New subfolder</Text>
            <TextField value={name} onChangeText={setName} placeholder="Folder name" autoFocus />
            <Row gap={t.spacing.sm} justify="flex-end" style={{ marginTop: t.spacing.md }}>
              <Button title="Cancel" variant="ghost" onPress={() => { setName(''); onCancel(); }} />
              <Button title="Create" onPress={() => { onCreate(name); setName(''); }} disabled={!name.trim()} />
            </Row>
          </Card>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
