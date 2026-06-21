import {
  View, Text, FlatList, Pressable, StyleSheet,
  RefreshControl, ActivityIndicator, Platform,
} from 'react-native';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch, apiRequest, queryClient } from '@/lib/query-client';
import { colors } from '@/constants/colors';

interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
  link?: string;
}

const NOTIF_ICONS: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  order: { name: 'receipt-outline', color: colors.info },
  payment: { name: 'wallet-outline', color: colors.success },
  message: { name: 'chatbubble-outline', color: colors.primary },
  review: { name: 'star-outline', color: colors.warning },
  security: { name: 'shield-outline', color: colors.danger },
  default: { name: 'notifications-outline', color: colors.muted },
};

function NotifItem({ item, onRead }: { item: Notification; onRead: (id: number) => void }) {
  const icon = NOTIF_ICONS[item.type] ?? NOTIF_ICONS.default;
  const timeStr = new Date(item.created_at).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  return (
    <Pressable
      style={[s.row, !item.is_read && s.rowUnread]}
      onPress={() => !item.is_read && onRead(item.id)}
    >
      <View style={[s.iconWrap, { backgroundColor: icon.color + '22' }]}>
        <Ionicons name={icon.name} size={22} color={icon.color} />
      </View>
      <View style={s.body}>
        <View style={s.topRow}>
          <Text style={[s.title, !item.is_read && s.titleUnread]} numberOfLines={1}>
            {item.title}
          </Text>
          {!item.is_read && <View style={s.dot} />}
        </View>
        <Text style={s.msg} numberOfLines={2}>{item.message}</Text>
        <Text style={s.time}>{timeStr}</Text>
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['/api/notifications'],
    queryFn: () => apiFetch<{ notifications: Notification[] } | Notification[]>('/api/notifications?limit=50'),
    refetchInterval: 30_000,
  });

  const notifs = Array.isArray(data) ? data : (data as any)?.notifications ?? [];

  const readMutation = useMutation({
    mutationFn: (id: number) => apiRequest(`/api/notifications/${id}/read`, { method: 'PUT' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/notifications'] }),
  });

  const readAllMutation = useMutation({
    mutationFn: () => apiRequest('/api/notifications/read-all', { method: 'PUT' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/notifications'] }),
  });

  const unread = notifs.filter((n: Notification) => !n.is_read).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[s.header, { paddingTop: topPad + 8 }]}>
        <View>
          <Text style={s.headerTitle}>Thông báo</Text>
          {unread > 0 && <Text style={s.unreadCount}>{unread} chưa đọc</Text>}
        </View>
        {unread > 0 && (
          <Pressable onPress={() => readAllMutation.mutate()}>
            <Text style={s.readAll}>Đọc tất cả</Text>
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : notifs.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="notifications-off-outline" size={48} color={colors.mutedDark} />
          <Text style={s.empty}>Không có thông báo nào</Text>
        </View>
      ) : (
        <FlatList
          data={notifs}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <NotifItem item={item} onRead={(id) => readMutation.mutate(id)} />}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!!notifs.length}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ItemSeparatorComponent={() => <View style={s.sep} />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { color: colors.foreground, fontSize: 22, fontFamily: 'Inter_700Bold' },
  unreadCount: { color: colors.muted, fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  readAll: { color: colors.primary, fontSize: 14, fontFamily: 'Inter_500Medium', paddingTop: 4 },
  row: {
    flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 14, gap: 14, alignItems: 'flex-start',
  },
  rowUnread: { backgroundColor: colors.primary + '08' },
  iconWrap: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  body: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  title: { color: colors.foreground, fontSize: 14, fontFamily: 'Inter_500Medium', flex: 1 },
  titleUnread: { fontFamily: 'Inter_700Bold' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  msg: { color: colors.muted, fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18, marginBottom: 6 },
  time: { color: colors.mutedDark, fontSize: 11, fontFamily: 'Inter_400Regular' },
  sep: { height: 1, backgroundColor: colors.border },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  empty: { color: colors.muted, fontSize: 15, fontFamily: 'Inter_500Medium' },
});
