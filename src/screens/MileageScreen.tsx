/**
 * Mileage — GPS-logged or manual business trips, plus manual cash expenses so
 * the expense record is complete even without a paper receipt. Trips apply the
 * configurable per-mile rate and flow into reports.
 */
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  ListRow,
  TextField,
  EmptyState,
  IconButton,
  Divider,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import * as DB from '@/db';
import {
  startTracking,
  stopTracking,
  isTracking,
  getLiveMiles,
  setOnUpdate,
} from '@/services/mileageService';
import { formatMoney, round2, parseMoney } from '@/lib/money';
import { formatDate, todayIso } from '@/lib/dates';
import type { MileageTrip } from '@/types';

export default function MileageScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const [trips, setTrips] = useState<MileageTrip[]>([]);
  const [tracking, setTracking] = useState(false);
  const [liveMiles, setLiveMiles] = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [showCash, setShowCash] = useState(false);

  const load = useCallback(async () => {
    setTrips(await DB.Mileage.listTrips());
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
      // Reconcile with the mileage singleton: the GPS watcher keeps running if
      // this screen unmounted mid-trip, so re-derive UI state from the service
      // and swap our fresh setter in for the previous (dead) closure.
      setTracking(isTracking());
      setLiveMiles(getLiveMiles());
      setOnUpdate((m) => setLiveMiles(m));
      // Detach on blur/unmount so the watcher never calls into a dead closure.
      return () => setOnUpdate(null);
    }, [load]),
  );

  const totalMiles = round2(trips.reduce((s, tr) => s + tr.distance_miles, 0));
  const totalAmount = round2(trips.reduce((s, tr) => s + tr.amount, 0));

  const toggleTracking = async () => {
    if (tracking) {
      const { distanceMiles, path } = await stopTracking();
      setTracking(false);
      setLiveMiles(0);
      if (distanceMiles > 0.05) {
        await DB.Mileage.createTrip({
          start_time: path[0] ? new Date(path[0].t).toISOString() : todayIso(),
          end_time: todayIso(),
          distance_miles: round2(distanceMiles),
          rate_per_mile: settings.mileage_rate,
          path_json: JSON.stringify(path),
          memo: 'GPS trip',
        });
        load();
      } else {
        Alert.alert('Mileage', 'Trip was too short to record.');
      }
    } else {
      const ok = await startTracking((m) => setLiveMiles(round2(m)));
      if (ok) setTracking(true);
      else Alert.alert('Location', 'Location permission is required to log GPS trips.');
    }
  };

  return (
    <Screen scroll edges={['top']}>
      <Text variant="title">Mileage</Text>

      <Row gap={t.spacing.md} style={{ marginTop: t.spacing.md }}>
        <Card style={{ flex: 1 }}>
          <Text variant="caption" color={t.colors.textMuted}>TOTAL MILES</Text>
          <Text variant="heading">{totalMiles}</Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text variant="caption" color={t.colors.textMuted}>REIMBURSABLE</Text>
          <Text variant="heading">{formatMoney(totalAmount, settings.default_currency)}</Text>
        </Card>
      </Row>

      {/* GPS tracking */}
      <Card style={{ marginTop: t.spacing.lg, alignItems: 'center', gap: t.spacing.sm }}>
        {tracking ? (
          <>
            <Text variant="title" color={t.colors.brand}>{liveMiles} mi</Text>
            <Text variant="caption" color={t.colors.textMuted}>Tracking… keep this screen open</Text>
            <Button title="Stop & save" variant="danger" icon="stop" onPress={toggleTracking} />
          </>
        ) : (
          <Button title="Start GPS trip" icon="navigate" onPress={toggleTracking} />
        )}
      </Card>

      <Row gap={t.spacing.md} style={{ marginTop: t.spacing.md }}>
        <Button title="Manual trip" icon="add" variant="secondary" style={{ flex: 1 }} onPress={() => setShowManual(true)} />
        <Button title="Cash expense" icon="cash-outline" variant="secondary" style={{ flex: 1 }} onPress={() => setShowCash(true)} />
      </Row>

      <SectionHeader title="Trips" />
      {trips.length === 0 ? (
        <EmptyState icon="car-outline" title="No trips yet" message="Start a GPS trip or add one manually." />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
          {trips.map((tr, i) => (
            <View key={tr.id}>
              {i > 0 ? <Divider spacing={0} /> : null}
              <ListRow
                icon={tr.is_manual ? 'create-outline' : 'navigate-outline'}
                title={`${tr.distance_miles} mi`}
                subtitle={`${formatDate(tr.start_time.slice(0, 10), settings.date_format)} · ${tr.memo || 'Trip'}`}
                rightText={formatMoney(tr.amount, settings.default_currency)}
                onPress={() =>
                  Alert.alert('Delete trip?', `${tr.distance_miles} mi`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: async () => { await DB.Mileage.deleteTrip(tr.id); load(); } },
                  ])
                }
              />
            </View>
          ))}
        </Card>
      )}

      <ManualTripModal
        visible={showManual}
        defaultRate={settings.mileage_rate}
        onClose={() => setShowManual(false)}
        onSaved={() => { setShowManual(false); load(); }}
      />
      <CashExpenseModal
        visible={showCash}
        currency={settings.default_currency}
        onClose={() => setShowCash(false)}
        onSaved={() => { setShowCash(false); load(); }}
      />
    </Screen>
  );
}

function Sheet({ visible, title, children, onClose }: { visible: boolean; title: string; children: React.ReactNode; onClose: () => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation()} style={{ backgroundColor: t.colors.bg, borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl, padding: t.spacing.lg }}>
          <Row justify="space-between" align="center" style={{ marginBottom: t.spacing.md }}>
            <Text variant="subheading">{title}</Text>
            <IconButton icon="close" onPress={onClose} />
          </Row>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ManualTripModal({ visible, defaultRate, onClose, onSaved }: { visible: boolean; defaultRate: number; onClose: () => void; onSaved: () => void }) {
  const [distance, setDistance] = useState('');
  const [rate, setRate] = useState(String(defaultRate));
  const [memo, setMemo] = useState('');
  const save = async () => {
    const d = parseMoney(distance);
    if (d <= 0) return;
    await DB.Mileage.createTrip({
      start_time: todayIso(),
      end_time: todayIso(),
      distance_miles: d,
      rate_per_mile: parseMoney(rate),
      memo,
      is_manual: true,
    });
    setDistance(''); setMemo('');
    onSaved();
  };
  return (
    <Sheet visible={visible} title="Manual trip" onClose={onClose}>
      <TextField label="Distance (miles)" value={distance} onChangeText={setDistance} keyboardType="decimal-pad" placeholder="0" />
      <TextField label="Rate per mile" value={rate} onChangeText={setRate} keyboardType="decimal-pad" prefix="$" />
      <TextField label="Memo" value={memo} onChangeText={setMemo} placeholder="e.g. Client visit" />
      <Button title="Save trip" onPress={save} />
    </Sheet>
  );
}

function CashExpenseModal({ visible, currency, onClose, onSaved }: { visible: boolean; currency: string; onClose: () => void; onSaved: () => void }) {
  const lookups = useLookups();
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const save = async () => {
    const a = parseMoney(amount);
    if (a <= 0) return;
    await DB.CashExpenses.createCashExpense({
      date: todayIso(),
      vendor,
      amount: a,
      currency,
      memo,
      category_id: lookups.categories[0]?.id ?? null,
    });
    setVendor(''); setAmount(''); setMemo('');
    onSaved();
  };
  return (
    <Sheet visible={visible} title="Cash expense" onClose={onClose}>
      <TextField label="Vendor" value={vendor} onChangeText={setVendor} placeholder="e.g. Parking" />
      <TextField label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" prefix="$" />
      <TextField label="Memo" value={memo} onChangeText={setMemo} />
      <Button title="Save expense" onPress={save} />
    </Sheet>
  );
}
