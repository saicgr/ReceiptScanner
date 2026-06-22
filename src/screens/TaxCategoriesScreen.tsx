/**
 * TaxCategoriesScreen — CRUD editor for tax-deduction categories (V2).
 *
 * Each tax category has a name, a default `deductible_percent` (0–100, applied to
 * receipts assigned to it) and an optional `schedule_c_line` reference for the
 * tax report. Edits flow through the TaxCategory DAO (`@/db`) then refresh the
 * shared lookups store so the review screen + tax report pick them up.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  IconButton,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Spacer,
  Text,
  TextField,
  useTheme,
} from '@/components/ui';
import * as DB from '@/db';
import { useLookups } from '@/store/lookups';
import type { TaxCategory } from '@/types';

/** Clamp a free-typed percent string into a valid 0–100 number. */
function parsePercent(raw: string): number {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export default function TaxCategoriesScreen() {
  const t = useTheme();
  const refresh = useLookups((s) => s.refresh);

  const [items, setItems] = useState<TaxCategory[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Editor modal state. `editing` is null when adding a new tax category.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TaxCategory | null>(null);
  const [name, setName] = useState('');
  const [percent, setPercent] = useState('100'); // kept as string for the input
  const [scheduleLine, setScheduleLine] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const rows = await DB.listTaxCategories();
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
    setPercent('100');
    setScheduleLine('');
    setModalOpen(true);
  };

  const openEdit = (tc: TaxCategory) => {
    setEditing(tc);
    setName(tc.name);
    setPercent(String(tc.deductible_percent));
    setScheduleLine(tc.schedule_c_line ?? '');
    setModalOpen(true);
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return; // name is required
    const deductible_percent = parsePercent(percent);
    const schedule_c_line = scheduleLine.trim() ? scheduleLine.trim() : null;
    setSaving(true);
    try {
      if (editing) {
        await DB.updateTaxCategory(editing.id, {
          name: trimmedName,
          deductible_percent,
          schedule_c_line,
        });
      } else {
        await DB.createTaxCategory({
          name: trimmedName,
          deductible_percent,
          schedule_c_line,
        });
      }
      setModalOpen(false);
      await load();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tc: TaxCategory) => {
    // FK ON DELETE SET NULL leaves receipts intact, just without a tax category.
    await DB.deleteTaxCategory(tc.id);
    await load();
    await refresh();
  };

  return (
    <Screen scroll>
      <SectionHeader title="Tax Categories" action="Add" actionIcon="add" onAction={openAdd} />

      {!loaded ? (
        <Text variant="body" color={t.colors.textMuted}>
          Loading…
        </Text>
      ) : items.length === 0 ? (
        <EmptyState
          icon="calculator-outline"
          title="No tax categories"
          message="Create categories like “Meals (50%)” or “Home Office” to track deductible spend."
          action="Add tax category"
          onAction={openAdd}
        />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
          {items.map((tc, i) => (
            <View key={tc.id}>
              <ListRow
                title={tc.name}
                subtitle={tc.schedule_c_line ? `Schedule C: ${tc.schedule_c_line}` : undefined}
                icon="calculator-outline"
                onPress={() => openEdit(tc)}
                right={
                  <Row gap={t.spacing.xs}>
                    <Badge label={`${tc.deductible_percent}%`} color={t.colors.brand} background={t.colors.brandTint} />
                    <IconButton
                      icon="create-outline"
                      onPress={() => openEdit(tc)}
                      color={t.colors.textMuted}
                      accessibilityLabel={`Edit ${tc.name}`}
                    />
                    <IconButton
                      icon="trash-outline"
                      onPress={() => remove(tc)}
                      color={t.colors.danger}
                      accessibilityLabel={`Delete ${tc.name}`}
                    />
                  </Row>
                }
              />
              {i < items.length - 1 ? <Divider spacing={0} /> : null}
            </View>
          ))}
        </Card>
      )}

      <TaxCategoryEditorModal
        visible={modalOpen}
        editing={editing}
        name={name}
        percent={percent}
        scheduleLine={scheduleLine}
        saving={saving}
        onChangeName={setName}
        onChangePercent={setPercent}
        onChangeScheduleLine={setScheduleLine}
        onClose={() => setModalOpen(false)}
        onSave={save}
      />
    </Screen>
  );
}

/** Bottom-sheet style editor for a single tax category (add or edit). */
function TaxCategoryEditorModal({
  visible,
  editing,
  name,
  percent,
  scheduleLine,
  saving,
  onChangeName,
  onChangePercent,
  onChangeScheduleLine,
  onClose,
  onSave,
}: {
  visible: boolean;
  editing: TaxCategory | null;
  name: string;
  percent: string;
  scheduleLine: string;
  saving: boolean;
  onChangeName: (v: string) => void;
  onChangePercent: (v: string) => void;
  onChangeScheduleLine: (v: string) => void;
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
            <Text variant="subheading">{editing ? 'Edit Tax Category' : 'New Tax Category'}</Text>
            <IconButton icon="close" onPress={onClose} />
          </Row>

          <TextField
            label="Name"
            value={name}
            onChangeText={onChangeName}
            placeholder="e.g. Meals (50%)"
            autoFocus
          />
          <TextField
            label="Deductible %"
            value={percent}
            onChangeText={onChangePercent}
            placeholder="0–100"
            keyboardType="decimal-pad"
            right={<Text variant="body" color={t.colors.textMuted}>%</Text>}
          />
          <TextField
            label="Schedule C line (optional)"
            value={scheduleLine}
            onChangeText={onChangeScheduleLine}
            placeholder="e.g. Line 24b"
          />

          <Spacer size={12} />
          <Button
            title={editing ? 'Save changes' : 'Add tax category'}
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
