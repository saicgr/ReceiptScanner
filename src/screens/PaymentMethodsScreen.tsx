/**
 * PaymentMethodsScreen — CRUD editor for payment-method tags (cash, credit card,
 * PayPal, gift card, …). A payment method only carries a name; everything else
 * (default flag, sort order) is managed by the DAO. Edits flow through the
 * PaymentMethod DAO (`@/db`) then refresh the shared lookups store.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
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
import type { PaymentMethod } from '@/types';

export default function PaymentMethodsScreen() {
  const t = useTheme();
  const refresh = useLookups((s) => s.refresh);

  const [items, setItems] = useState<PaymentMethod[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Editor modal state. `editing` is null when adding a new method.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const rows = await DB.listPaymentMethods();
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
    setModalOpen(true);
  };

  const openEdit = (p: PaymentMethod) => {
    setEditing(p);
    setName(p.name);
    setModalOpen(true);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return; // name is required
    setSaving(true);
    try {
      if (editing) {
        await DB.updatePaymentMethod(editing.id, { name: trimmed });
      } else {
        await DB.createPaymentMethod({ name: trimmed });
      }
      setModalOpen(false);
      await load();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: PaymentMethod) => {
    // FK ON DELETE SET NULL leaves receipts intact, just without a payment tag.
    await DB.deletePaymentMethod(p.id);
    await load();
    await refresh();
  };

  return (
    <Screen scroll>
      <SectionHeader title="Payment Methods" action="Add" actionIcon="add" onAction={openAdd} />

      {!loaded ? (
        <Text variant="body" color={t.colors.textMuted}>
          Loading…
        </Text>
      ) : items.length === 0 ? (
        <EmptyState
          icon="card-outline"
          title="No payment methods"
          message="Add methods like Cash, Credit Card or PayPal to tag how you paid."
          action="Add method"
          onAction={openAdd}
        />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
          {items.map((p, i) => (
            <View key={p.id}>
              <ListRow
                title={p.name}
                subtitle={p.is_default ? 'Default' : undefined}
                icon="card-outline"
                onPress={() => openEdit(p)}
                right={
                  <Row gap={t.spacing.xs}>
                    <IconButton
                      icon="create-outline"
                      onPress={() => openEdit(p)}
                      color={t.colors.textMuted}
                      accessibilityLabel={`Edit ${p.name}`}
                    />
                    <IconButton
                      icon="trash-outline"
                      onPress={() => remove(p)}
                      color={t.colors.danger}
                      accessibilityLabel={`Delete ${p.name}`}
                    />
                  </Row>
                }
              />
              {i < items.length - 1 ? <Divider spacing={0} /> : null}
            </View>
          ))}
        </Card>
      )}

      <PaymentEditorModal
        visible={modalOpen}
        editing={editing}
        name={name}
        saving={saving}
        onChangeName={setName}
        onClose={() => setModalOpen(false)}
        onSave={save}
      />
    </Screen>
  );
}

/** Bottom-sheet style editor for a single payment method (add or edit). */
function PaymentEditorModal({
  visible,
  editing,
  name,
  saving,
  onChangeName,
  onClose,
  onSave,
}: {
  visible: boolean;
  editing: PaymentMethod | null;
  name: string;
  saving: boolean;
  onChangeName: (v: string) => void;
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
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={{ alignItems: 'center', paddingBottom: t.spacing.sm }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />
          </View>
          <Row justify="space-between" style={{ marginBottom: t.spacing.md }}>
            <Text variant="subheading">{editing ? 'Edit Payment Method' : 'New Payment Method'}</Text>
            <IconButton icon="close" onPress={onClose} />
          </Row>

          <TextField
            label="Name"
            value={name}
            onChangeText={onChangeName}
            placeholder="e.g. Credit Card"
            autoFocus
          />

          <Spacer size={12} />
          <Button
            title={editing ? 'Save changes' : 'Add method'}
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
