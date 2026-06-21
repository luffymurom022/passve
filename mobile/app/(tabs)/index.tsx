import {
  View, Text, FlatList, Pressable, StyleSheet,
  RefreshControl, ActivityIndicator, Image, Platform,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { apiFetch } from '@/lib/query-client';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/colors';

interface Ticket {
  id: number;
  title: string;
  event_date: string;
  venue: string;
  price: number;
  image_url?: string;
  seller_name?: string;
  category?: string;
  is_verified?: boolean;
}

function TicketCard({ item }: { item: Ticket }) {
  return (
    <Pressable
      style={s.card}
      onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
    >
      <View style={s.cardImageWrap}>
        {item.image_url ? (
          <Image source={{ uri: item.image_url }} style={s.cardImage} />
        ) : (
          <View style={[s.cardImage, s.cardImagePlaceholder]}>
            <Ionicons name="ticket-outline" size={32} color={colors.mutedDark} />
          </View>
        )}
        {item.is_verified && (
          <View style={s.badge}>
            <Ionicons name="shield-checkmark" size={12} color="#fff" />
          </View>
        )}
      </View>
      <View style={s.cardBody}>
        <Text style={s.cardTitle} numberOfLines={2}>{item.title}</Text>
        <View style={s.cardRow}>
          <Ionicons name="calendar-outline" size={12} color={colors.muted} />
          <Text style={s.cardMeta}>{item.event_date ? new Date(item.event_date).toLocaleDateString('vi-VN') : '—'}</Text>
        </View>
        <View style={s.cardRow}>
          <Ionicons name="location-outline" size={12} color={colors.muted} />
          <Text style={s.cardMeta} numberOfLines={1}>{item.venue || '—'}</Text>
        </View>
        <View style={s.cardFooter}>
          <Text style={s.price}>{item.price ? item.price.toLocaleString('vi-VN') + '₫' : 'Thương lượng'}</Text>
          {item.category && (
            <View style={s.tag}>
              <Text style={s.tagText}>{item.category}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['/api/tickets'],
    queryFn: () => apiFetch<{ tickets: Ticket[] } | Ticket[]>('/api/tickets?limit=40'),
  });

  const tickets = Array.isArray(data) ? data : (data as any)?.tickets ?? [];

  const topPadding = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[s.header, { paddingTop: topPadding + 8 }]}>
        <View>
          <Text style={s.greeting}>Xin chào{user ? `, ${user.name.split(' ').pop()}` : ''} 👋</Text>
          <Text style={s.subtitle}>Tìm vé sự kiện hôm nay</Text>
        </View>
        <Pressable style={s.searchBtn} onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}>
          <Ionicons name="search" size={22} color={colors.foreground} />
        </Pressable>
      </View>

      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : tickets.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="ticket-outline" size={48} color={colors.mutedDark} />
          <Text style={s.empty}>Chưa có vé nào</Text>
        </View>
      ) : (
        <FlatList
          data={tickets}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <TicketCard item={item} />}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          scrollEnabled={!!tickets.length}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  greeting: { color: colors.foreground, fontSize: 20, fontFamily: 'Inter_700Bold' },
  subtitle: { color: colors.muted, fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  searchBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center',
  },
  list: { padding: 16 },
  card: {
    backgroundColor: colors.card, borderRadius: colors.radius,
    overflow: 'hidden', borderWidth: 1, borderColor: colors.border,
  },
  cardImageWrap: { position: 'relative' },
  cardImage: { width: '100%', height: 160, resizeMode: 'cover' },
  cardImagePlaceholder: { backgroundColor: colors.cardAlt, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: colors.success, borderRadius: 8,
    padding: 4,
  },
  cardBody: { padding: 14, gap: 6 },
  cardTitle: { color: colors.foreground, fontSize: 16, fontFamily: 'Inter_600SemiBold', lineHeight: 22 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardMeta: { color: colors.muted, fontSize: 12, fontFamily: 'Inter_400Regular', flex: 1 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  price: { color: colors.primary, fontSize: 16, fontFamily: 'Inter_700Bold' },
  tag: { backgroundColor: colors.cardAlt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { color: colors.muted, fontSize: 11, fontFamily: 'Inter_500Medium' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  empty: { color: colors.muted, fontSize: 15, fontFamily: 'Inter_500Medium' },
});
