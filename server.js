// server.js
console.log("Supabase URL:", process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log("Stripe Secret Key:", !!process.env.STRIPE_SECRET_KEY);
console.log("App URL:", process.env.APP_URL);
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const QRCode = require("qrcode");

// 🔹 Para Node 16+ usamos node-fetch
const fetch = require("node-fetch");
globalThis.fetch = fetch;

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Supabase Admin
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });

// Evento
const EVENT_SLUG = "pool-sessions-vol-1";
const EVENT_NAME = "POOL SESSIONS VOL. 1";
const VENUE = "Staditche Centro Cultural";
const EVENT_DATE_TEXT = "15 de marzo · 3:00 PM";
const UNIT_PRICE = 250;
const MAX_PER_PURCHASE = 6;

// Generadores
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

// Endpoints
app.get("/", (req, res) => res.send("POOL SESSIONS TICKET SERVER RUNNING"));

// Remaining tickets
app.get("/remaining", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc("get_remaining_tickets", {
      p_event_slug: EVENT_SLUG,
    });
    if (error) throw error;
    res.json({ remaining: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;
    const quantity = Number(ticketQuantity);

    // Validaciones
    if (!buyerName || buyerName.trim().length < 2)
      return res.status(400).json({ error: "Nombre inválido." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail || ""))
      return res.status(400).json({ error: "Correo inválido." });
    if ((buyerPhone || "").replace(/\D/g, "").length < 10)
      return res.status(400).json({ error: "Número inválido." });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PER_PURCHASE)
      return res.status(400).json({ error: "Cantidad inválida." });

    // Verificar disponibilidad
    const { data: remainingData, error: remError } = await supabaseAdmin.rpc(
      "get_remaining_tickets",
      { p_event_slug: EVENT_SLUG }
    );
    if (remError) throw remError;
    const remaining = remainingData || 0;
    if (remaining <= 0) return res.status(400).json({ error: "Evento agotado" });

    const finalQuantity = Math.min(quantity, remaining);
    const totalAmount = finalQuantity * UNIT_PRICE;
    const orderCode = makeOrderCode();

    // Crear orden
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
        payment_status: "pending",
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // Crear sesión Stripe
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
            product_data: { name: EVENT_NAME },
          },
        },
      ],
      success_url: `${process.env.APP_URL}/success?order=${order.id}`,
      cancel_url: `${process.env.APP_URL}/cancel?order=${order.id}`,
    });

    // Guardar session id
    await supabaseAdmin.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

    res.json({ ok: true, checkoutUrl: session.url, orderId: order.id });
  } catch (error) {
    console.error("Create Checkout Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe Webhook
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    const { data: order } = await supabaseAdmin.from("orders").select("*").eq("id", orderId).single();

    if (order && order.payment_status !== "paid") {
      await supabaseAdmin
        .from("orders")
        .update({ payment_status: "paid", stripe_payment_intent: session.payment_intent || null })
        .eq("id", order.id);

      const tickets = Array.from({ length: order.ticket_quantity }).map((_, i) => ({
        order_id: order.id,
        event_slug: order.event_slug,
        ticket_code: makeTicketCode(i),
        qr_token: makeQrToken(),
        status: "valid",
      }));

      await supabaseAdmin.from("tickets").insert(tickets);
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
