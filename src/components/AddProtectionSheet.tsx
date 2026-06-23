/**
 * AddProtectionSheet — a reusable modal to quick-add a mail-in REBATE (TASK 81)
 * or a PRICE-DROP / price-protection claim (TASK 79) for a receipt.
 *
 * Deadlines are entered as "days from today" and converted to an ISO date with
 * the same `addDays` helper the rest of the app uses, so we don't need a native
 * date-picker dependency (consistent with the return/warranty window inputs on
 * the Review screen). On confirm we call the matching service, which persists the
 * row AND schedules the local reminders via the existing notification infra.
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import {
  Button,
  IconButton,
  MoneyInput,
  Row,
  Text,
  TextField,
  useTheme,
} from '@/components/ui';
import { addDays, todayIso, formatDate } from '@/lib/dates';
import { createRebate } from '@/services/rebateService';
import { createPriceProtection, claimableAmount } from '@/services/priceProtectionService';

export type ProtectionKind = 'rebate' | 'price_protection';

interface Props {
  visible: boolean;
  kind: ProtectionKind;
  receiptId: string;
  vendor: string;
  currency: string;
  /** The price the user paid (prefills price-protection original_price). */
  paidAmount: number;
  dateFormat: string;
  onClose: () => void;
  onSaved: () => void;
}

/** Parse a non-negative integer day count from raw text (null when blank). */
function parseDays(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Math.round(Number(t.replace(/[^0-9]/g, '')));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function AddProtectionSheet({
  visible,
  kind,
  receiptId,
  vendor,
  currency,
  paidAmount,
  dateFormat,
  onClose,
  onSaved,
}: Props) {
  const t = useTheme();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [submitDays, setSubmitDays] = useState('');
  const [payoutDays, setPayoutDays] = useState('');
  const [claimDays, setClaimDays] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setDescription('');
    setAmount(null);
    setCurrentPrice(null);
    setSubmitDays('');
    setPayoutDays('');
    setClaimDays('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const today = todayIso();
  const submitDeadline = parseDays(submitDays) != null ? addDays(today, parseDays(submitDays)!) : null;
  const payoutDeadline = parseDays(payoutDays) != null ? addDays(today, parseDays(payoutDays)!) : null;
  const claimDeadline = parseDays(claimDays) != null ? addDays(today, parseDays(claimDays)!) : null;

  const onConfirm = async () => {
    setBusy(true);
    try {
      if (kind === 'rebate') {
        await createRebate({
          receipt_id: receiptId,
          vendor,
          currency,
          description: description.trim(),
          amount: amount ?? 0,
          submission_deadline: submitDeadline,
          payout_deadline: payoutDeadline,
          status: 'pending',
        });
      } else {
        await createPriceProtection({
          receipt_id: receiptId,
          vendor,
          currency,
          item_name: description.trim() || vendor,
          original_price: paidAmount,
          current_price: currentPrice ?? 0,
          claim_deadline: claimDeadline,
          status: 'open',
        });
      }
      reset();
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const isRebate = kind === 'rebate';
  const title = isRebate ? 'Track a rebate' : 'Track a price drop';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }} onPress={close}>
        <Pressable
          style={{
            backgroundColor: t.colors.bg,
            borderTopLeftRadius: t.radius.xl,
            borderTopRightRadius: t.radius.xl,
            paddingTop: t.spacing.md,
            maxHeight: '85%',
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={{ alignItems: 'center', paddingBottom: t.spacing.sm }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />
          </View>
          <Row justify="space-between" align="center" style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="subheading">{title}</Text>
            <IconButton icon="close" onPress={close} />
          </Row>

          <ScrollView contentContainerStyle={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl }}>
            <TextField
              label={isRebate ? 'Description' : 'Item'}
              value={description}
              onChangeText={setDescription}
              placeholder={isRebate ? 'e.g. $20 mail-in rebate' : vendor}
            />

            {isRebate ? (
              <>
                <MoneyInput label="Rebate amount" value={amount} onCommit={setAmount} prefix={currency} />
                <TextField
                  label="Submit within (days)"
                  value={submitDays}
                  onChangeText={setSubmitDays}
                  placeholder="30"
                  keyboardType="number-pad"
                />
                {submitDeadline ? (
                  <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: -t.spacing.sm, marginBottom: t.spacing.md }}>
                    Submit by {formatDate(submitDeadline, dateFormat)}
                  </Text>
                ) : null}
                <TextField
                  label="Expect payout within (days)"
                  value={payoutDays}
                  onChangeText={setPayoutDays}
                  placeholder="90"
                  keyboardType="number-pad"
                />
                {payoutDeadline ? (
                  <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: -t.spacing.sm, marginBottom: t.spacing.md }}>
                    Chase if not paid by {formatDate(payoutDeadline, dateFormat)}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
                  You paid {currency} {paidAmount.toFixed(2)}. Enter the lower price you saw.
                </Text>
                <MoneyInput label="Lower price seen" value={currentPrice} onCommit={setCurrentPrice} prefix={currency} />
                {currentPrice != null ? (
                  <Text variant="caption" color={t.colors.success} style={{ marginTop: -t.spacing.sm, marginBottom: t.spacing.md }}>
                    Potential refund: {currency} {claimableAmount({ original_price: paidAmount, current_price: currentPrice }).toFixed(2)}
                  </Text>
                ) : null}
                <TextField
                  label="Claim within (days)"
                  value={claimDays}
                  onChangeText={setClaimDays}
                  placeholder="14"
                  keyboardType="number-pad"
                />
                {claimDeadline ? (
                  <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: -t.spacing.sm, marginBottom: t.spacing.md }}>
                    Claim by {formatDate(claimDeadline, dateFormat)}
                  </Text>
                ) : null}
              </>
            )}

            <Button title="Save & set reminder" icon="notifications-outline" onPress={onConfirm} loading={busy} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
