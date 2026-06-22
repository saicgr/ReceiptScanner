/**
 * CategoriesScreen — CRUD editor for user-defined spend categories.
 *
 * Each category has a name, a color swatch (picked from a preset palette) and an
 * icon (Ionicons glyph key, matching how the seed + DB store them). All edits go
 * straight through the Category DAO (`@/db`) and then refresh the shared lookups
 * store so every other screen (review, history, stats) sees the change at once.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
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
  Spacer,
  Text,
  TextField,
  useTheme,
  type IconName,
} from '@/components/ui';
import * as DB from '@/db';
import { useLookups } from '@/store/lookups';
import type { Category } from '@/types';

/** Preset swatches users pick from (keeps colors on-brand + accessible). */
const SWATCHES = [
  '#0E7C66', '#13A085', '#16A34A', '#2563EB', '#0891B2',
  '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#F59E0B',
  '#475569', '#64748B',
];

/** Curated Ionicons glyph keys that read well as small category icons. */
const ICON_CHOICES: IconName[] = [
  'cart', 'restaurant', 'car', 'briefcase', 'airplane',
  'flash', 'hardware-chip', 'medkit', 'film', 'home',
  'cafe', 'gift', 'fitness', 'paw', 'school',
  'shirt', 'build', 'wine', 'book', 'ellipsis-horizontal',
];

export default function CategoriesScreen() {
  const t = useTheme();
  const refresh = useLookups((s) => s.refresh);

  const [items, setItems] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Editor modal state. `editing` is null when adding a brand-new category.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [icon, setIcon] = useState<IconName>('cart');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const rows = await DB.listCategories();
    setItems(rows);
    setLoaded(true);
  }, []);

  // Reload whenever the screen regains focus (e.g. after seed/import elsewhere).
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
    setIcon('cart');
    setModalOpen(true);
  };

  const openEdit = (c: Category) => {
    setEditing(c);
    setName(c.name);
    setColor(c.color);
    setIcon(c.icon as IconName);
    setModalOpen(true);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return; // name is required; ignore empty saves
    setSaving(true);
    try {
      if (editing) {
        await DB.updateCategory(editing.id, { name: trimmed, color, icon });
      } else {
        await DB.createCategory({ name: trimmed, color, icon });
      }
      setModalOpen(false);
      await load();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Category) => {
    // FK ON DELETE SET NULL keeps receipts intact, just uncategorized.
    await DB.deleteCategory(c.id);
    await load();
    await refresh();
  };

  return (
    <Screen scroll>
      <SectionHeader title="Categories" action="Add" actionIcon="add" onAction={openAdd} />

      {!loaded ? (
        <Text variant="body" color={t.colors.textMuted}>
          Loading…
        </Text>
      ) : items.length === 0 ? (
        <EmptyState
          icon="pricetags-outline"
          title="No categories yet"
          message="Create categories to organize your receipts by spend type."
          action="Add category"
          onAction={openAdd}
        />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
          {items.map((c, i) => (
            <View key={c.id}>
              <ListRow
                title={c.name}
                subtitle={c.is_default ? 'Default' : undefined}
                left={
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: t.radius.md,
                      backgroundColor: c.color + '22',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name={c.icon as IconName} size={18} color={c.color} />
                  </View>
                }
                onPress={() => openEdit(c)}
                right={
                  <Row gap={t.spacing.xs}>
                    <IconButton
                      icon="create-outline"
                      onPress={() => openEdit(c)}
                      color={t.colors.textMuted}
                      accessibilityLabel={`Edit ${c.name}`}
                    />
                    <IconButton
                      icon="trash-outline"
                      onPress={() => remove(c)}
                      color={t.colors.danger}
                      accessibilityLabel={`Delete ${c.name}`}
                    />
                  </Row>
                }
              />
              {i < items.length - 1 ? <Divider spacing={0} /> : null}
            </View>
          ))}
        </Card>
      )}

      <CategoryEditorModal
        visible={modalOpen}
        editing={editing}
        name={name}
        color={color}
        icon={icon}
        saving={saving}
        onChangeName={setName}
        onChangeColor={setColor}
        onChangeIcon={setIcon}
        onClose={() => setModalOpen(false)}
        onSave={save}
      />
    </Screen>
  );
}

/** Bottom-sheet style editor for a single category (add or edit). */
function CategoryEditorModal({
  visible,
  editing,
  name,
  color,
  icon,
  saving,
  onChangeName,
  onChangeColor,
  onChangeIcon,
  onClose,
  onSave,
}: {
  visible: boolean;
  editing: Category | null;
  name: string;
  color: string;
  icon: IconName;
  saving: boolean;
  onChangeName: (v: string) => void;
  onChangeColor: (v: string) => void;
  onChangeIcon: (v: IconName) => void;
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
            <Text variant="subheading">{editing ? 'Edit Category' : 'New Category'}</Text>
            <IconButton icon="close" onPress={onClose} />
          </Row>

          <ScrollView keyboardShouldPersistTaps="handled">
            <TextField
              label="Name"
              value={name}
              onChangeText={onChangeName}
              placeholder="e.g. Groceries"
              autoFocus
            />

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

            <Spacer size={20} />
            <Text variant="label" color={t.colors.textMuted}>
              ICON
            </Text>
            <Spacer size={8} />
            <Row gap={t.spacing.sm} wrap>
              {ICON_CHOICES.map((ic) => {
                const active = ic === icon;
                return (
                  <Pressable
                    key={ic}
                    onPress={() => onChangeIcon(ic)}
                    accessibilityLabel={`Icon ${ic}`}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: t.radius.md,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: active ? color + '22' : t.colors.surface,
                      borderWidth: 1,
                      borderColor: active ? color : t.colors.border,
                    }}
                  >
                    <Icon name={ic} size={20} color={active ? color : t.colors.textMuted} />
                  </Pressable>
                );
              })}
            </Row>

            <Spacer size={24} />
            <Button
              title={editing ? 'Save changes' : 'Add category'}
              icon="checkmark"
              onPress={onSave}
              loading={saving}
              disabled={!name.trim()}
              fullWidth
            />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
