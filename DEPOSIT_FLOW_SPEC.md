# Технічна специфікація: Обробка гарантійних платежів (Double Deposit Flow)

## Огляд процесу

Система використовує модель "подвійного депозиту" (10% + 10%) для підтвердження замовлень:

1. **Виконавець** вносить 10% від вартості замовлення (гарантійна сума виконавця)
2. **Заказчик** вносить 110% від вартості замовлення (100% робота + 10% гарантійна сума заказчикa)
3. Після оплати обох сторін замовлення переходить у статус `confirmed`

---

## Статуси замовлення

```typescript
type OrderStatus =
  | 'draft'              // Чернетка
  | 'published'          // Опубліковано (видимо в біржі)
  | 'requires_confirmation'  // Очікує підтвердження заказчиком (12г таймер)
  | 'confirmed'          // Підтверджено (обидва депозити оплачені)
  | 'started'            // В роботі
  | 'completed'          // Завершено
  | 'arbitration'        // Арбітраж
  | 'cancelled';         // Скасовано
```

### Діаграма переходів статусів

```
published
    ↓ (performer приймає + оплачує 10%)
requires_confirmation ──(12г таймер)──> published/cancelled
    ↓ (customer оплачує 110%)
confirmed
    ↓ (performer починає роботу)
started
    ↓ (performer завершує роботу)
completed
```

---

## Ролі користувачів та їх панелі

### Customer Panel (Панель заказчикa)
- Переглядає замовлення зі статусом `requires_confirmation`
- Отримує Push: "Виконавець вніс гарантійну суму"
- Бачить таймер 12 годин
- Кнопка: "Оплатити 110%"

### Performer Panel (Панель виконавця)
- Переглядає замовлення в біржі (`published`)
- Кнопка: "Прийняти замовлення"
- Після прийняття: очікує оплати заказчиком
- Отримує Push: "Заказчик вніс гарантійну суму"
- Кнопка: "Почати роботу" (коли статус `confirmed`)

---

## API Endpoints

### 1. Отримання списку замовлень (Customer)

```typescript
GET /api/v1/orders?status=requires_confirmation&limit=20&offset=0
Authorization: Bearer <accessToken>

Response 200:
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "cmxxx...",
        "status": "requires_confirmation",
        "title": "м. Київ, вул. Хрещатик 1",
        "areaHa": 120.5,
        "budget": 48000,
        "currency": "UAH",
        "depositAmount": 4800,        // 10%
        "depositDeadline": "2026-03-22T10:30:00Z",  // 12г від accept
        "acceptedAt": "2026-03-21T22:30:00Z",
        "performer": {
          "id": "user_yyy",
          "name": "ФОП Петренко"
        },
        "createdAt": "2026-03-20T15:00:00Z"
      }
    ],
    "page": { "limit": 20, "offset": 0, "totalCount": 5 }
  }
}
```

**Обробка клієнтом:**
- Фільтрувати замовлення зі статусом `requires_confirmation`
- Обчислювати залишок часу: `timeLeft = depositDeadline - now`
- Якщо `timeLeft <= 0` → показати "Час вийшов"
- Якщо `timeLeft > 0` → показати таймер зворотного відліку

---

### 2. Створення платежу (Customer Intent)

```typescript
POST /api/v1/orders/:orderId/deposits/customer-intent
Authorization: Bearer <accessToken>
Content-Type: application/json

Body:
{
  "method": "card"
}

Response 200:
{
  "success": true,
  "data": {
    "paymentIntent": {
      "id": "pay_xxx",
      "orderId": "cmxxx...",
      "amount": 52800,              // 110% = 100% + 10%
      "currency": "UAH",
      "provider": "liqpay",
      "checkoutUrl": "https://www.liqpay.ua/api/3/checkout",
      "data": "base64(...)",        // LiqPay data
      "signature": "base64(...)"    // LiqPay signature
    }
  }
}
```

**Сума оплати:**
```typescript
const amount = budget * 1.1  // 110%
const breakdown = {
  work: budget,              // 100%
  deposit: budget * 0.1      // 10%
}
```

---

### 3. Створення платежу (Performer Intent)

```typescript
POST /api/v1/marketplace/orders/:orderId/deposits/performer-intent
Authorization: Bearer <accessToken>
Content-Type: application/json

Body:
{
  "method": "card"
}

Response 200:
{
  "success": true,
  "data": {
    "paymentIntent": {
      "id": "pay_yyy",
      "orderId": "cmxxx...",
      "amount": 4800,               // 10%
      "currency": "UAH",
      "provider": "liqpay",
      "checkoutUrl": "https://www.liqpay.ua/api/3/checkout",
      "data": "base64(...)",
      "signature": "base64(...)"
    }
  }
}
```

---

### 4. Прийняття замовлення (Performer)

```typescript
POST /api/v1/marketplace/orders/:orderId/accept
Authorization: Bearer <accessToken>
Content-Type: application/json

Body:
{
  "paymentIntentId": "pay_yyy"
}

Response 200:
{
  "success": true,
  "data": {
    "order": {
      "id": "cmxxx...",
      "status": "requires_confirmation"
    },
    "agreementId": null
  }
}

Response 409 Conflict:
{
  "success": false,
  "code": "CONFLICT",
  "message": "Order already accepted"
}
```

**Обробка клієнтом:**
- Якщо `409` → показати "Замовлення вже прийнято іншим виконавцем"
- Якщо `200` → видалити замовлення з біржі, перейти на екран "Очікування оплати заказчиком"

---

### 5. Отримання повідомлень (Notifications)

```typescript
GET /api/v1/notifications?role=customer&type=deposit&unreadOnly=true
Authorization: Bearer <accessToken>

Response 200:
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "notif_xxx",
        "type": "deposit",
        "title": "Виконавець вніс гарантійну суму",
        "message": "Замовлення #cmxxx. У вас є 12 годин...",
        "readAt": null,
        "createdAt": "2026-03-21T10:30:00Z",
        "orderId": "cmxxx...",
        "data": {
          "type": "deposit_performer_paid",
          "role": "customer",
          "depositAmount": 4800,
          "currency": "UAH",
          "deadlineHours": 12
        }
      }
    ]
  }
}
```

**Фільтрація по ролях:**
- `role=customer` → тільки повідомлення для заказчикa
- `role=performer` → тільки повідомлення для виконавця
- `type=deposit` → тільки повідомлення про депозити

---

## WebSocket Events

### Підключення

```typescript
const ws = new WebSocket('wss://api.example.com/ws');
ws.send(JSON.stringify({
  type: 'auth',
  token: accessToken
}));
```

### Подія: `deposit.performer_paid` (для заказчикa)

```typescript
// Server → Client
{
  "eventId": "evt_xxx",
  "type": "deposit.performer_paid",
  "version": "1.0",
  "timestamp": "2026-03-21T10:30:00Z",
  "targets": { "userIds": ["customer_user_id"] },
  "data": {
    "orderId": "cmxxx...",
    "performerId": "user_yyy",
    "depositAmount": 4800,
    "currency": "UAH",
    "deadlineHours": 12
  }
}
```

**Обробка клієнтом:**
1. Отримати подію
2. Зробити refetch `GET /api/v1/orders/:orderId`
3. Зробити refetch `GET /api/v1/notifications?role=customer&type=deposit`
4. Показати Push-сповіщення (якщо додаток у фоні)
5. Оновити UI: показати таймер 12 годин

---

### Подія: `deposit.customer_required` (для виконавця)

```typescript
// Server → Client
{
  "eventId": "evt_yyy",
  "type": "deposit.customer_required",
  "version": "1.0",
  "timestamp": "2026-03-21T11:00:00Z",
  "targets": { "userIds": ["performer_user_id"] },
  "data": {
    "orderId": "cmxxx...",
    "customerId": "user_zzz"
  }
}
```

**Обробка клієнтом:**
1. Отримати подію
2. Зробити refetch `GET /api/v1/marketplace/orders/:orderId`
3. Зробити refetch `GET /api/v1/notifications?role=performer&type=deposit`
4. Показати Push-сповіщення
5. Оновити UI: показати "Заказчик оплатив, можна починати"

---

### Подія: `order.status_changed`

```typescript
// Server → Client
{
  "eventId": "evt_zzz",
  "type": "order.status_changed",
  "version": "1.0",
  "timestamp": "2026-03-21T11:30:00Z",
  "targets": { "userIds": ["customer_user_id", "performer_user_id"] },
  "data": {
    "orderId": "cmxxx...",
    "fromStatus": "requires_confirmation",
    "toStatus": "confirmed"
  }
}
```

**Обробка клієнтом:**
1. Отримати подію
2. Зробити refetch `GET /api/v1/orders/:orderId`
3. Оновити статус в UI
4. Для виконавця: показати кнопку "Почати роботу"
5. Для заказчикa: показати "Замовлення підтверджено"

---

## Push Notifications

### Формат Push (Customer)

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Виконавець вніс гарантійну суму",
  "body": "Замовлення #cmxxx. У вас є 12 годин для внесення гарантійної суми (4800 UAH)",
  "data": {
    "orderId": "cmxxx...",
    "type": "deposit_performer_paid",
    "role": "customer",
    "depositAmount": 4800,
    "currency": "UAH",
    "deadlineHours": 12
  }
}
```

### Формат Push (Performer)

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Заказчик вніс гарантійну суму",
  "body": "Замовлення #cmxxx. Заказчик підтвердив оплату. Можна починати роботу.",
  "data": {
    "orderId": "cmxxx...",
    "type": "deposit_customer_paid",
    "role": "performer"
  }
}
```

### Обробка Push клієнтом

```typescript
// Expo Push Handler
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const { type, role } = notification.request.content.data;
    
    // Фільтрація по ролях
    const userRole = await getUserRole(); // 'customer' | 'performer'
    if (role && role !== userRole) {
      return null; // Ігнорувати повідомлення не для цієї ролі
    }
    
    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    };
  },
});

// Обробка натискання на Push
Notifications.addNotificationResponseReceivedListener((response) => {
  const { orderId, type } = response.notification.request.content.data;
  
  if (type === 'deposit_performer_paid') {
    // Перейти на екран оплати депозиту
    navigation.navigate('DepositPayment', { orderId });
  } else if (type === 'deposit_customer_paid') {
    // Перейти на екран замовлення
    navigation.navigate('OrderDetail', { orderId });
  }
});
```

---

## UI Screens

### 1. Customer: Екран оплати депозиту

**Компоненти:**
```typescript
interface DepositPaymentScreenProps {
  orderId: string;
}

interface DepositPaymentState {
  order: Order | null;
  paymentIntent: PaymentIntent | null;
  isLoading: boolean;
  timeLeft: number; // секунди
}
```

**UI Elements:**
- Заголовок: "Гарантійна сума"
- Інформаційна картка:
  - "Виконавець вніс гарантійну суму ✅"
  - "У вас є 12 годин для підтвердження"
- Таймер зворотного відліку: `11:59:30`
- Сума до сплати: `52,800 UAH` (розбивка: 48,000 + 4,800)
- Кнопка: "Оплатити" → відкриває LiqPay WebView
- Кнопка: "Скасувати" → підтвердження скасування

**Таймер:**
```typescript
useEffect(() => {
  const deadline = new Date(order.depositDeadline).getTime();
  
  const interval = setInterval(() => {
    const now = Date.now();
    const timeLeft = Math.max(0, deadline - now);
    setTimeLeft(timeLeft);
    
    if (timeLeft === 0) {
      // Час вийшов
      showTimeoutAlert();
      navigation.goBack();
    }
  }, 1000);
  
  return () => clearInterval(interval);
}, [order.depositDeadline]);
```

---

### 2. Performer: Екран прийняття замовлення

**Компоненти:**
```typescript
interface AcceptOrderScreenProps {
  orderId: string;
}
```

**UI Elements:**
- Деталі замовлення (адреса, площа, бюджет)
- Кнопка: "Прийняти замовлення"
- Modal підтвердження:
  - "Ви впевнені?"
  - "Необхідно оплатити гарантійну суму 4,800 UAH"
  - Кнопки: "Скасувати" / "Прийняти"

**Логіка:**
```typescript
const handleAccept = async () => {
  try {
    // 1. Створити payment intent
    const intent = await api.post(
      `/marketplace/orders/${orderId}/deposits/performer-intent`,
      { method: 'card' }
    );
    
    // 2. Відкрити LiqPay
    const result = await openLiqPay(intent.data.checkoutUrl);
    
    if (result.success) {
      // 3. Підтвердити оплату
      await api.post(`/payments/${intent.data.id}/confirm`, {
        providerPayload: result.providerPayload
      });
      
      // 4. Прийняти замовлення
      const acceptResult = await api.post(
        `/marketplace/orders/${orderId}/accept`,
        { paymentIntentId: intent.data.id }
      );
      
      // 5. Перейти на екран очікування
      navigation.navigate('WaitingForCustomer', { orderId });
    }
  } catch (error) {
    if (error.response?.status === 409) {
      Alert.alert('Замовлення вже прийнято', 
        'Інший виконавець випередив вас');
    } else {
      Alert.alert('Помилка', error.message);
    }
  }
};
```

---

### 3. Performer: Екран очікування оплати заказчиком

**UI Elements:**
- Статус: "Очікуємо підтвердження заказчиком"
- Інформація: "Ви внесли гарантійну суму 4,800 UAH ✅"
- Таймер: "У заказчикa є 12 годин"
- Кнопка: "Скасувати бронь" (опціонально)

---

### 4. Customer: Information Card в повідомленнях

**Компонент:**
```typescript
interface DepositNotificationCardProps {
  notification: Notification;
}

const DepositNotificationCard: React.FC<DepositNotificationCardProps> = ({
  notification
}) => {
  const { type, depositAmount, deadlineHours } = notification.data;
  
  if (type === 'deposit_performer_paid') {
    return (
      <Card>
        <Icon name="shield-check" color="green" />
        <Title>Виконавець вніс гарантійну суму</Title>
        <Message>
          Виконавець підтвердив готовність до роботи.
          У вас є {deadlineHours} годин для внесення гарантійної суми.
        </Message>
        <Amount>{depositAmount} UAH</Amount>
        <Button onPress={() => navigateToPayment(notification.orderId)}>
          Оплатити
        </Button>
      </Card>
    );
  }
  
  if (type === 'deposit_customer_paid') {
    return (
      <Card>
        <Icon name="check-circle" color="blue" />
        <Title>Заказчик вніс гарантійну суму</Title>
        <Message>
          Заказчик підтвердив оплату.
          Можна починати роботу.
        </Message>
        <Button onPress={() => navigateToOrder(notification.orderId)}>
          Перейти до замовлення
        </Button>
      </Card>
    );
  }
};
```

---

## Обробка помилок

### 1. Гонка виконавців (Race Condition)

```typescript
// Multiple performers try to accept the same order
try {
  await api.post(`/marketplace/orders/${orderId}/accept`, {
    paymentIntentId
  });
} catch (error) {
  if (error.response?.status === 409) {
    // Show conflict UI
    Alert.alert(
      'Замовлення вже прийнято',
      'Інший виконавець випередив вас. Це замовлення більше не доступне.',
      [{ text: 'OK', onPress: () => navigation.goBack() }]
    );
  }
}
```

---

### 2. Тайм-аут заказчикa (12 годин)

**Server-side:**
- Фоновий job перевіряє `depositDeadline < now`
- Переводить замовлення в `published` або `cancelled`
- Повертає гарантійну суму виконавцю

**Client-side:**
```typescript
useEffect(() => {
  if (order.status === 'requires_confirmation') {
    const deadline = new Date(order.depositDeadline).getTime();
    const now = Date.now();
    
    if (deadline < now) {
      // Час вийшов
      Alert.alert(
        'Час підтвердження вийшов',
        'Заказчик не підтвердив замовлення вчасно. Гарантійна сума повернута.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    }
  }
}, [order.status, order.depositDeadline]);
```

---

### 3. Помилка платежу LiqPay

```typescript
const handleLiqPayResult = async (response: LiqPayResponse) => {
  if (response.status !== 'success') {
    // Show error
    Alert.alert(
      'Помилка платежу',
      `Статус: ${response.status}. Спробуйте ще раз або виберіть інший спосіб оплати.`,
      [{ text: 'Спробувати ще раз' }, { text: 'Скасувати' }]
    );
    return;
  }
  
  // Continue with confirmation
  await confirmPayment(response);
};
```

---

## Polling & Refetch

### React Query Setup

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000, // 30 секунд
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

// Custom hook for orders with requires_confirmation status
export const useRequiresConfirmationOrders = (userId: string) => {
  return useQuery({
    queryKey: ['orders', 'requires_confirmation', userId],
    queryFn: () => api.get('/api/v1/orders?status=requires_confirmation'),
    refetchInterval: 10000, // Poll кожні 10 секунд
  });
};

// Custom hook for single order
export const useOrder = (orderId: string) => {
  return useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get(`/api/v1/orders/${orderId}`),
    refetchInterval: 5000, // Poll кожні 5 секунд для таймера
  });
};
```

---

### WebSocket + Polling Strategy

```typescript
// WebSocket connection manager
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  
  connect(token: string) {
    this.ws = new WebSocket(`wss://api.example.com/ws`);
    
    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: 'auth', token }));
      this.reconnectAttempts = 0;
    };
    
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
    
    this.ws.onclose = () => {
      // Reconnect with exponential backoff
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
      setTimeout(() => this.connect(token), delay);
      this.reconnectAttempts++;
    };
  }
  
  private handleMessage(message: DomainEvent) {
    switch (message.type) {
      case 'deposit.performer_paid':
        // Invalidate customer orders query
        queryClient.invalidateQueries(['orders', 'requires_confirmation']);
        // Show notification
        showNotification(message);
        break;
        
      case 'deposit.customer_required':
        // Invalidate performer orders query
        queryClient.invalidateQueries(['marketplace-orders']);
        showNotification(message);
        break;
        
      case 'order.status_changed':
        // Invalidate specific order query
        queryClient.invalidateQueries(['order', message.data.orderId]);
        break;
    }
  }
}
```

---

## Local State Management

### Redux/Zustand Store Structure

```typescript
interface AppState {
  orders: {
    customerOrders: Order[];
    performerOrders: Order[];
    requiresConfirmation: Order[];
  };
  notifications: {
    items: Notification[];
    unreadCount: number;
  };
  deposits: {
    pendingPayments: Record<string, PaymentIntent>;
    completedPayments: Record<string, Payment>;
  };
  ui: {
    activeTimers: Record<string, number>; // orderId -> timeLeft
  };
}
```

---

## Security Considerations

### Token Management

```typescript
// Store tokens securely
import * as SecureStore from 'expo-secure-store';

const tokenStorage = {
  async getToken() {
    return await SecureStore.getItemAsync('access_token');
  },
  
  async saveToken(token: string) {
    await SecureStore.setItemAsync('access_token', token);
  },
  
  async deleteToken() {
    await SecureStore.deleteItemAsync('access_token');
  },
};

// Auto-refresh tokens
const setupTokenRefresh = () => {
  setInterval(async () => {
    try {
      const response = await api.post('/api/v1/auth/refresh');
      await tokenStorage.saveToken(response.data.accessToken);
    } catch (error) {
      // Token refresh failed, redirect to login
      navigation.navigate('Login');
    }
  }, 14 * 60 * 1000); // Refresh every 14 minutes (token expires in 15min)
};
```

---

## Testing Checklist

### Customer Flow
- [ ] Отримати Push "Виконавець вніс гарантійну суму"
- [ ] Натиснути на Push → відкривається екран оплати
- [ ] Таймер відлічує 12 годин
- [ ] Створити payment intent → відкривається LiqPay
- [ ] Успішна оплата → статус змінюється на `confirmed`
- [ ] Отримати WebSocket `order.status_changed`
- [ ] Перевірити відображення в `GET /api/v1/orders`

### Performer Flow
- [ ] Бачити замовлення в біржі
- [ ] Натиснути "Прийняти" → 409 якщо вже прийнято
- [ ] Створити payment intent → LiqPay
- [ ] Успішна оплата → статус `requires_confirmation`
- [ ] Отримати Push "Заказчик вніс гарантійну суму"
- [ ] Бачити кнопку "Почати роботу" коли `confirmed`

### Edge Cases
- [ ] Гонка виконавців (409 Conflict)
- [ ] Тайм-аут 12 годин
- [ ] Помилка платежу LiqPay
- [ ] Втрата WebSocket з'єднання
- [ ] Refresh токена під час оплати

---

## Діаграма послідовності

```
Performer                    Backend                    Customer
   |                            |                           |
   |--[1] POST /accept--------->|                           |
   |                            |                           |
   |<--[2] 200 OK--------------|                           |
   |   (status: requires_conf)  |                           |
   |                            |                           |
   |                            |----[3] WebSocket -------->|
   |                            |   deposit.performer_paid  |
   |                            |                           |
   |                            |----[4] Push ------------->|
   |                            |   "Виконавець вніс..."    |
   |                            |                           |
   |                            |<--[5] GET /orders --------|
   |                            |   (status check)          |
   |                            |                           |
   |                            |<--[6] POST /customer-intent|
   |                            |   (create payment)        |
   |                            |                           |
   |<--[7] WebSocket -----------|                           |
   |   deposit.customer_required|                           |
   |                            |                           |
   |<--[8] Push ---------------|                           |
   |   "Заказчик вніс..."       |                           |
   |                            |                           |
   |                            |----[9] WebSocket -------->|
   |                            |   order.status_changed    |
   |                            |   (confirmed)             |
   |                            |                           |
```

---

## Contact & Support

Для технічної підтримки та питань щодо інтеграції:
- API документація: `/endpoints.md`
- WebSocket документація: розділ "Realtime" в `/endpoints.md`
- LiqPay документація: https://www.liqpay.ua/documentation
