// server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase ---
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Stripe ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Evento ---
const EVENT_SLUG = "pool-sessions-vol-1";
const EVENT_NAME = "POOL SESSIONS VOL. 1";
const VENUE = "Staditche Centro Cultural";
const EVENT_DATE_TEXT = "15 de marzo · 3:00 PM";
const UNIT_PRICE = 250;
const MAX_PER_PURCHASE = 6;

// --- Generadores ---
function makeOrderCode() {
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `PS-ORD-${Date.now()}-${random}`;
}

function makeTicketCode(index) {
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `PS-T-${Date.now()}-${index + 1}-${random}`;
}

function makeQrToken() {
  return crypto.randomUUID();
}

// --- Rutas ---
app.get("/", (req, res) => {
  res.send("POOL SESSIONS TICKET SERVER RUNNING");
});

// Ruta para crear sesión de Stripe
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;
    const quantity = Number(ticketQuantity);

    // --- Validaciones básicas ---
    if (!buyerName || buyerName.trim().length < 2) return res.status(400).json({ error: "Nombre inválido." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail || "")) return res.status(400).json({ error: "Correo inválido." });
    const phoneDigits = (buyerPhone || "").replace(/\D/g, "");
    if (phoneDigits.length < 10) return res.status(400).json({ error: "Número inválido." });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PER_PURCHASE) return res.status(400).json({ error: "Cantidad inválida." });

    const finalQuantity = quantity; // 🔥 por ahora sin control de stock
    const totalAmount = finalQuantity * UNIT_PRICE;
    const orderCode = makeOrderCode();

    // --- Crear orden en Supabase ---
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert({
        order_code: orderCode,
        event_slug: EVENT_SLUG,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone,
        ticket_quantity: finalQuantity,
        unit_price: UNIT_PRICE,
        total_amount: totalAmount,
        payment_status: "pending"
      })
      .select()
      .single();

    if (orderError) return res.status(500).json({ error: "No se pudo crear la orden." });

    // --- Crear sesión de Stripe ---
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      client_reference_id: order.id,
      metadata: { order_id: order.id, ticket_quantity: String(finalQuantity) },
      line_items: [
        {
          quantity: finalQuantity,
          price_data: {
            currency: "mxn",
            unit_amount: UNIT_PRICE * 100,
            product_data: { name: EVENT_NAME }
          }
        }
      ],
      success_url: `${process.env.APP_URL}/success?order=${order.id}`,
      cancel_url: `${process.env.APP_URL}/cancel?order=${order.id}`
    });

    // --- Guardar ID de sesión en la orden ---
    await supabaseAdmin
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", order.id);

    res.json({ ok: true, checkoutUrl: session.url, orderId: order.id });
  } catch (error) {
    console.error("Error creando sesión Stripe:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Webhook Stripe ---
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    // --- Marcar pago como pagado ---
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (order && order.payment_status !== "paid") {
      await supabaseAdmin
        .from("orders")
        .update({ payment_status: "paid", stripe_payment_intent: session.payment_intent || null })
        .eq("id", order.id);

      // --- Generar tickets ---
      const tickets = Array.from({ length: order.ticket_quantity }).map((_, i) => ({
        order_id: order.id,
        event_slug: order.event_slug,
        ticket_code: makeTicketCode(i),
        qr_token: makeQrToken(),
        status: "valid"
      }));

      await supabaseAdmin.from("tickets").insert(tickets);
    }
  }

  res.json({ received: true });
});

// --- Info de orden y tickets ---
app.get("/order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const { data: order } = await supabaseAdmin.from("orders").select("*").eq("id", orderId).single();
  const { data: tickets } = await supabaseAdmin.from("tickets").select("*").eq("order_id", orderId);
  res.json({ order, tickets });
});

// --- Validación de boleto ---
app.get("/validate", async (req, res) => {
  const { token } = req.query;
  const { data: ticket } = await supabaseAdmin.from("tickets").select("*").eq("qr_token", token).single();

  if (!ticket) return res.json({ valid: false, message: "Boleto no encontrado" });
  if (ticket.status === "used") return res.json({ valid: false, message: "Boleto ya utilizado" });
  if (ticket.status === "cancelled") return res.json({ valid: false, message: "Boleto cancelado" });

  res.json({ valid: true, message: "Boleto válido", ticket });
});

// --- QR de boleto ---
app.get("/ticket/:ticketId/qr", async (req, res) => {
  const { ticketId } = req.params;
  const { data: ticket } = await supabaseAdmin.from("tickets").select("*").eq("id", ticketId).single();
  if (!ticket) return res.status(404).json({ message: "Ticket no encontrado" });

  const validationUrl = `${process.env.APP_URL}/validate?token=${ticket.qr_token}`;
  const qr = await QRCode.toBuffer(validationUrl, { type: "png", width: 500, margin: 2 });
  res.setHeader("Content-Type", "image/png");
  res.send(qr);
});

// --- Servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
