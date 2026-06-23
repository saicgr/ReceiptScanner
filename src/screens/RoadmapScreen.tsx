/**
 * Roadmap & Feature Requests — ReceiptSnap's "we listen to users" surface, the
 * thing the competitor never had. Shows the curated roadmap grouped by status
 * (In progress / Planned / Shipped), lets users upvote what they want next, and
 * lets them submit their own ideas.
 *
 * Data comes from the proxy (`fetchRoadmap`) with a bundled offline fallback, so
 * the screen always renders. Votes are optimistic and reconciled with the
 * server's fresh count; when the backend is unreachable, voting/submitting are
 * disabled with a clear notice (the curated list still shows).
 */
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  ListRow,
  TextField,
  Badge,
  Divider,
  IconButton,
  SelectSheet,
  useTheme,
  type SelectOption,
} from '@/components/ui';
import {
  fetchRoadmap,
  toggleRoadmapVote,
  submitFeatureRequest,
  type RoadmapItem,
  type RoadmapStatus,
} from '@/services/roadmapClient';

/** Display order + labels for the three status groups. */
const GROUPS: { status: RoadmapStatus; title: string }[] = [
  { status: 'in_progress', title: 'In progress' },
  { status: 'planned', title: 'Planned' },
  { status: 'shipped', title: 'Shipped' },
];

/** Optional "area" tags for a feature request (freeform on the backend). */
const CATEGORY_OPTIONS: SelectOption[] = [
  { label: 'Accuracy', value: 'Accuracy' },
  { label: 'Capture & scanning', value: 'Capture' },
  { label: 'Export & reports', value: 'Export' },
  { label: 'Organization', value: 'Organization' },
  { label: 'Mileage', value: 'Mileage' },
  { label: 'Other', value: 'Other' },
];

export default function RoadmapScreen() {
  const t = useTheme();

  const [items, setItems] = useState<RoadmapItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  // Ids with a vote request in flight — guards against double-taps.
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Feature-request modal state.
  const [modalOpen, setModalOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { items: next, online: live } = await fetchRoadmap();
    setItems(next);
    setOnline(live);
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onVote = async (item: RoadmapItem) => {
    if (!online) {
      Alert.alert('You appear to be offline', 'Connect to the internet to vote on features.');
      return;
    }
    if (pending.has(item.id)) return;

    // Optimistic flip.
    const optimisticVoted = !item.voted;
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? { ...it, voted: optimisticVoted, upvotes: Math.max(0, it.upvotes + (optimisticVoted ? 1 : -1)) }
          : it,
      ),
    );
    setPending((prev) => new Set(prev).add(item.id));

    try {
      const fresh = await toggleRoadmapVote(item.id);
      // Reconcile with the server's authoritative count.
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, voted: fresh.voted, upvotes: fresh.upvotes } : it)),
      );
    } catch (err) {
      // Revert the optimistic change and tell the user.
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, voted: item.voted, upvotes: item.upvotes }
            : it,
        ),
      );
      Alert.alert('Vote not saved', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const openRequest = () => {
    setTitle('');
    setDescription('');
    setCategory(null);
    setModalOpen(true);
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await submitFeatureRequest({ title: trimmed, description: description.trim(), category });
      setModalOpen(false);
      Alert.alert('Thanks! 🎉', 'Your feature request was sent. We read every one.');
    } catch (err) {
      Alert.alert('Could not send', err instanceof Error ? err.message : 'Please try again later.');
    } finally {
      setSubmitting(false);
    }
  };

  const categoryLabel = CATEGORY_OPTIONS.find((c) => c.value === category)?.label;

  return (
    <Screen scroll>
      <Text variant="title">Roadmap</Text>
      <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 6 }}>
        See what we're building, vote on what matters to you, and tell us what's missing. We read
        every request.
      </Text>

      <Button
        title="Request a feature"
        icon="bulb-outline"
        fullWidth
        style={{ marginTop: t.spacing.lg }}
        onPress={openRequest}
      />

      {!online && loaded ? (
        <Card style={{ marginTop: t.spacing.md, backgroundColor: t.colors.warningTint, borderColor: t.colors.warning }}>
          <Row gap={t.spacing.sm} align="flex-start">
            <Ionicons name="cloud-offline-outline" size={18} color={t.colors.warning} />
            <Text variant="body" color={t.colors.text} style={{ flex: 1 }}>
              You're offline — showing the latest roadmap we have. Voting and requests will work once
              you're back online.
            </Text>
          </Row>
        </Card>
      ) : null}

      {!loaded ? (
        <Text variant="body" color={t.colors.textMuted} style={{ marginTop: t.spacing.xl }}>
          Loading…
        </Text>
      ) : (
        GROUPS.map(({ status, title: groupTitle }) => {
          const group = items.filter((it) => it.status === status);
          if (group.length === 0) return null;
          return (
            <View key={status}>
              <SectionHeader title={groupTitle} />
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {group.map((item, i) => (
                  <View key={item.id}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <ListRow
                      title={item.title}
                      subtitle={item.description}
                      right={
                        item.status === 'shipped' ? (
                          <Badge
                            label="Shipped"
                            icon="checkmark-circle"
                            color={t.colors.success}
                            background={t.colors.successTint}
                          />
                        ) : (
                          <VotePill
                            count={item.upvotes}
                            voted={item.voted}
                            busy={pending.has(item.id)}
                            disabled={!online}
                            onPress={() => onVote(item)}
                          />
                        )
                      }
                    />
                  </View>
                ))}
              </Card>
            </View>
          );
        })
      )}

      {/* Feature-request modal */}
      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }}
          onPress={() => setModalOpen(false)}
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
              <Text variant="subheading">Request a feature</Text>
              <IconButton icon="close" onPress={() => setModalOpen(false)} />
            </Row>

            <ScrollView keyboardShouldPersistTaps="handled">
              <TextField
                label="What would you like?"
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Export directly to FreshBooks"
                autoFocus
              />
              <TextField
                label="More detail (optional)"
                value={description}
                onChangeText={setDescription}
                placeholder="How would you use it? What problem does it solve?"
                multiline
              />
              <Text variant="label" color={t.colors.textMuted} style={{ marginBottom: 6 }}>
                AREA (OPTIONAL)
              </Text>
              <ListRow
                title={categoryLabel ?? 'Choose an area'}
                icon="apps-outline"
                onPress={() => setSheetOpen(true)}
              />

              <Button
                title="Send request"
                icon="paper-plane-outline"
                onPress={submit}
                loading={submitting}
                disabled={!title.trim()}
                fullWidth
                style={{ marginTop: t.spacing.lg }}
              />
              <Text variant="caption" color={t.colors.textMuted} align="center" style={{ marginTop: t.spacing.sm }}>
                Sent privately to the ReceiptSnap team — not shown to other users.
              </Text>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <SelectSheet
        visible={sheetOpen}
        title="Area"
        options={CATEGORY_OPTIONS}
        selected={category ? [category] : []}
        onClose={() => setSheetOpen(false)}
        onSelect={(v) => setCategory(v[0] ?? null)}
      />
    </Screen>
  );
}

/** A compact upvote control: ▲ + count, filled when this device has voted. */
function VotePill({
  count,
  voted,
  busy,
  disabled,
  onPress,
}: {
  count: number;
  voted: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const accent = voted ? t.colors.brand : t.colors.textMuted;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityLabel={voted ? 'Remove your vote' : 'Upvote this feature'}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minWidth: 52,
        justifyContent: 'center',
        paddingHorizontal: t.spacing.sm,
        paddingVertical: 6,
        borderRadius: t.radius.pill,
        borderWidth: 1,
        borderColor: voted ? t.colors.brand : t.colors.border,
        backgroundColor: voted ? t.colors.brand + '18' : t.colors.surface,
        opacity: (disabled ? 0.5 : 1) * (pressed || busy ? 0.7 : 1),
      })}
    >
      <Ionicons name={voted ? 'caret-up' : 'caret-up-outline'} size={15} color={accent} />
      <Text variant="label" color={accent}>
        {count}
      </Text>
    </Pressable>
  );
}
