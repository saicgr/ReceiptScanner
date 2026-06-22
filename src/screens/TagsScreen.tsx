/**
 * TagsScreen — CRUD editor for tags used to group receipts by job or trip.
 *
 * A tag has a name, a color and a `kind` (plain tag / job / trip). The kind
 * drives the dedicated job & trip filters in History and the export-by-job/trip
 * feature, so it is a first-class editable field here. Edits flow through the
 * Tag DAO (`@/db`) then refresh the shared lookups store.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  SegmentedControl,
  Spacer,
  Text,
  TextField,
  useTheme,
  type IconName,
} from '@/components/ui';
import * as DB from '@/db';
import { useLookups } from '@/store/lookups';
import type { Tag } from '@/types';

type TagKind = Tag['kind'];

/** Preset swatches users pick from. */
const SWATCHES = [
  '#0E7C66', '#13A085', '#16A34A', '#2563EB', '#0891B2',
  '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#F59E0B',
  '#475569', '#64748B',
];

const KIND_OPTIONS: { label: string; value: TagKind }[] = [
  { label: 'Tag', value: 'tag' },
  { label: 'Job', value: 'job' },
  { label: 'Trip', value: 'trip' },
];

const KIND_ICON: Record<TagKind, IconName> = {
  tag: 'pricetag-outline',
  job: 'briefcase-outline',
  trip: 'airplane-outline',
};

const KIND_LABEL: Record<TagKind, string> = {
  tag: 'Tag',
  job: 'Job',
  trip: 'Trip',
};

export default function TagsScreen() {
  const t = useTheme();
  const refresh = useLookups((s) => s.refresh);

  const [items, setItems] = useState<Tag[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Editor modal state. `editing` is null when adding a new tag.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [kind, setKind] = useState<TagKind>('tag');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const rows = await DB.listTags();
    setItems(rows);
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setName('');
    setColor(SWATCHES[0]);
    setKind('tag');
    setModalOpen(true);
  };

  const openEdit = (tag: Tag) => {
    setEditing(tag);
    setName(tag.name);
    setColor(tag.color);
    setKind(tag.kind);
    setModalOpen(true);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return; // name is required
    setSaving(true);
    try {
      if (editing) {
        await DB.updateTag(editing.id, { name: trimmed, color, kind });
      } else {
        await DB.createTag({ name: trimmed, color, kind });
      }
      setModalOpen(false);
      await load();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tag: Tag) => {
    // Deleting a tag detaches it from receipts but never deletes the receipts.
    await DB.deleteTag(tag.id);
    await load();
    await refresh();
  };

  return (
    <Screen scroll>
      <SectionHeader title="Tags & Jobs" action="Add" actionIcon="add" onAction={openAdd} />

      {!loaded ? (
        <Text variant="body" color={t.colors.textMuted}>
          Loading…
        </Text>
      ) : items.length === 0 ? (
        <EmptyState
          icon="pricetags-outline"
          title="No tags yet"
          message="Create tags, jobs or trips to group receipts and filter/export by them."
          action="Add tag"
          onAction={openAdd}
        />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
          {items.map((tag, i) => (
            <View key={tag.id}>
              <ListRow
                title={tag.name}
                subtitle={KIND_LABEL[tag.kind]}
                left={
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: t.radius.md,
                      backgroundColor: tag.color + '22',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name={KIND_ICON[tag.kind]} size={18} color={tag.color} />
                  </View>
                }
                onPress={() => openEdit(tag)}
                right={
                  <Row gap={t.spacing.xs}>
                    <IconButton
                      icon="create-outline"
                      onPress={() => openEdit(tag)}
                      color={t.colors.textMuted}
                      accessibilityLabel={`Edit ${tag.name}`}
                    />
                    <IconButton
                      icon="trash-outline"
                      onPress={() => remove(tag)}
                      color={t.colors.danger}
                      accessibilityLabel={`Delete ${tag.name}`}
                    />
                  </Row>
                }
              />
              {i < items.length - 1 ? <Divider spacing={0} /> : null}
            </View>
          ))}
        </Card>
      )}

      <TagEditorModal
        visible={modalOpen}
        editing={editing}
        name={name}
        color={color}
        kind={kind}
        saving={saving}
        onChangeName={setName}
        onChangeColor={setColor}
        onChangeKind={setKind}
        onClose={() => setModalOpen(false)}
        onSave={save}
      />
    </Screen>
  );
}

/** Bottom-sheet style editor for a single tag (add or edit). */
function TagEditorModal({
  visible,
  editing,
  name,
  color,
  kind,
  saving,
  onChangeName,
  onChangeColor,
  onChangeKind,
  onClose,
  onSave,
}: {
  visible: boolean;
  editing: Tag | null;
  name: string;
  color: string;
  kind: TagKind;
  saving: boolean;
  onChangeName: (v: string) => void;
  onChangeColor: (v: string) => void;
  onChangeKind: (v: TagKind) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const t = useTheme();
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
          <Row justify="space-between" style={{ marginBottom: t.spacing.md }}>
            <Text variant="subheading">{editing ? 'Edit Tag' : 'New Tag'}</Text>
            <IconButton icon="close" onPress={onClose} />
          </Row>

          <TextField
            label="Name"
            value={name}
            onChangeText={onChangeName}
            placeholder="e.g. Client A / Italy 2026"
            autoFocus
          />

          <Text variant="label" color={t.colors.textMuted}>
            KIND
          </Text>
          <Spacer size={8} />
          <SegmentedControl options={KIND_OPTIONS} value={kind} onChange={onChangeKind} />

          <Spacer size={20} />
          <Text variant="label" color={t.colors.textMuted}>
            COLOR
          </Text>
          <Spacer size={8} />
          <Row gap={t.spacing.sm} wrap>
            {SWATCHES.map((sw) => {
              const active = sw.toLowerCase() === color.toLowerCase();
              return (
                <Pressable
                  key={sw}
                  onPress={() => onChangeColor(sw)}
                  accessibilityLabel={`Color ${sw}`}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: sw,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: active ? 3 : 1,
                    borderColor: active ? t.colors.text : t.colors.border,
                  }}
                >
                  {active ? <Icon name="checkmark" size={16} color="#FFFFFF" /> : null}
                </Pressable>
              );
            })}
          </Row>

          <Spacer size={24} />
          <Button
            title={editing ? 'Save changes' : 'Add tag'}
            icon="checkmark"
            onPress={onSave}
            loading={saving}
            disabled={!name.trim()}
            fullWidth
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
