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
app.post("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const EVENT_SLUG = "pool-sessions-vol-1";
const EVENT_NAME = "POOL SESSIONS VOL. 1";
const VENUE = "Staditche Centro Cultural";
const EVENT_DATE_TEXT = "15 de marzo · 3:00 PM";
const UNIT_PRICE = 250;
const MAX_PER_PURCHASE = 6;

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

app.get("/", (req, res) => {
  res.send("POOL SESSIONS TICKET SERVER RUNNING");
});

app.get("/remaining", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc(
      "get_remaining_tickets",
      { p_event_slug: EVENT_SLUG }
    );

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ remaining: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { buyerName, buyerEmail, buyerPhone, ticketQuantity } = req.body;
    const quantity = Number(ticketQuantity);

    if (!buyerName || buyerName.trim().length < 5) {
      return res.status(400).json({ error: "Nombre inválido." });
    }

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail || "");
    if (!emailValid) {
      return res.status(400).json({ error: "Correo inválido." });
    }

    const phoneDigits = (buyerPhone || "").replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      return res.status(400).json({ error: "Número inválido." });
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PER_PURCHASE) {
      return res.status(400).json({ error: "Cantidad inválida." });
    }

    const { data: remaining, error: remainingError } = await supabaseAdmin.rpc(
      "get_remaining_tickets",
      { p_event_slug: EVENT_SLUG }
    );

    if (remainingError) {
      return res.status(500).json({ error: "No se pudo consultar disponibilidad." });
    }

    if (!remaining || remaining <= 0) {
      return res.status(400).json({ error: "Evento agotado." });
    }

    const finalQuantity = Math.min(quantity, remaining);
    const totalAmount = finalQuantity * UNIT_PRICE;
    const orderCode = makeOrderCode();

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

    if (orderError) {
      return res.status(500).json({ error: "No se pudo crear la orden." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      client_reference_id: order.id,
      metadata: {
        order_id: order.id,
        ticket_quantity: String(finalQuantity)
      },
      line_items: [
        {
          quantity: finalQuantity,
          price_data: {
            currency: "mxn",
            unit_amount: UNIT_PRICE * 100,
            product_data: {
              name: EVENT_NAME
            }
          }
        }
      ],
      success_url: `${process.env.APP_URL}/success?order=${order.id}`,
      cancel_url: `${process.env.APP_URL}/cancel?order=${order.id}`
    });

    await supabaseAdmin
      .from("orders")
      .update({
        stripe_session_id: session.id
      })
      .eq("id", order.id);

    res.json({
      ok: true,
      checkoutUrl: session.url,
      orderId: order.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/stripe-webhook", async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (order && order.payment_status !== "paid") {
      await supabaseAdmin
        .from("orders")
        .update({
          payment_status: "paid",
          stripe_payment_intent: session.payment_intent || null
        })
        .eq("id", order.id);

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

app.get("/order/:orderId", async (req, res) => {
  const { orderId } = req.params;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  const { data: tickets } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("order_id", orderId);

  res.json({ order, tickets });
});

app.get("/validate", async (req, res) => {
  const { token } = req.query;

  const { data: ticket } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("qr_token", token)
    .single();

  if (!ticket) {
    return res.json({
      valid: false,
      message: "Boleto no encontrado"
    });
  }

  if (ticket.status === "used") {
    return res.json({
      valid: false,
      message: "Boleto ya utilizado"
    });
  }

  if (ticket.status === "cancelled") {
    return res.json({
      valid: false,
      message: "Boleto cancelado"
    });
  }

  res.json({
    valid: true,
    message: "Boleto válido",
    ticket
  });
});

app.get("/ticket/:ticketId/qr", async (req, res) => {
  const { ticketId } = req.params;

  const { data: ticket } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .single();

  if (!ticket) {
    return res.status(404).json({
      message: "Ticket no encontrado"
    });
  }

  const validationUrl = `${process.env.APP_URL}/validate?token=${ticket.qr_token}`;

  const qr = await QRCode.toBuffer(validationUrl, {
    type: "png",
    width: 500,
    margin: 2
  });

  res.setHeader("Content-Type", "image/png");
  res.send(qr);
});

app.get("/ticket/:ticketId", async (req, res) => {
  const { ticketId } = req.params;

  const { data: ticket } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .single();

  if (!ticket) {
    return res.status(404).send("<h1>Ticket no encontrado</h1>");
  }

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", ticket.order_id)
    .single();

  const qrImageUrl = `/ticket/${ticket.id}/qr`;

  const statusText =
    ticket.status === "valid"
      ? "VÁLIDO"
      : ticket.status === "used"
      ? "USADO"
      : "CANCELADO";

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${EVENT_NAME} · Ticket</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Inter, Arial, sans-serif;
          background:
            radial-gradient(circle at top left, rgba(0,255,170,0.12), transparent 28%),
            radial-gradient(circle at top right, rgba(0,170,255,0.10), transparent 28%),
            #0a0a0a;
          color: #f5f5f5;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .ticket {
          width: 100%;
          max-width: 860px;
          display: grid;
          grid-template-columns: 1.2fr 0.8fr;
          background: rgba(18,18,18,0.96);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 28px;
          overflow: hidden;
          box-shadow: 0 24px 70px rgba(0,0,0,0.45);
        }
        .left {
          padding: 34px;
          border-right: 1px dashed rgba(255,255,255,0.12);
        }
        .right {
          padding: 28px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          background: rgba(255,255,255,0.02);
        }
        .eyebrow {
          font-size: 12px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #8fffe0;
          margin-bottom: 10px;
          font-weight: 700;
        }
        h1 {
          margin: 0 0 10px;
          font-size: 2.5rem;
          line-height: 0.95;
          letter-spacing: -0.05em;
        }
        .sub {
          color: #b5b5b5;
          font-size: 1rem;
          line-height: 1.5;
          margin-bottom: 26px;
        }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
          margin-bottom: 22px;
        }
        .box {
          padding: 14px 16px;
          border-radius: 18px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .label {
          display: block;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.16em;
          color: #8f8f8f;
          margin-bottom: 8px;
        }
        .value {
          font-size: 1rem;
          font-weight: 700;
          line-height: 1.35;
        }
        .status {
          display: inline-block;
          padding: 10px 14px;
          border-radius: 999px;
          background: rgba(0,255,170,0.10);
          border: 1px solid rgba(0,255,170,0.25);
          color: #dffff4;
          font-weight: 800;
          letter-spacing: 0.08em;
          font-size: 0.86rem;
          margin-top: 6px;
        }
        .qr {
          width: 100%;
          max-width: 260px;
          background: white;
          padding: 14px;
          border-radius: 20px;
        }
        .qr img {
          width: 100%;
          display: block;
        }
        .ticket-code {
          font-weight: 800;
          font-size: 0.95rem;
          letter-spacing: 0.04em;
          text-align: center;
        }
        .small {
          font-size: 0.88rem;
          color: #a6a6a6;
          text-align: center;
          line-height: 1.5;
        }
        @media (max-width: 760px) {
          .ticket {
            grid-template-columns: 1fr;
          }
          .left {
            border-right: 0;
            border-bottom: 1px dashed rgba(255,255,255,0.12);
          }
        }
      </style>
    </head>
    <body>
      <div class="ticket">
        <div class="left">
          <div class="eyebrow">POOL SESSIONS</div>
          <h1>${EVENT_NAME}</h1>
          <div class="sub">
            Boleto individual con acceso único. Presenta este QR en la entrada.
          </div>

          <div class="grid">
            <div class="box">
              <span class="label">Venue</span>
              <div class="value">${VENUE}</div>
            </div>

            <div class="box">
              <span class="label">Fecha</span>
              <div class="value">${EVENT_DATE_TEXT}</div>
            </div>

            <div class="box">
              <span class="label">Comprador</span>
              <div class="value">${order?.buyer_name || "Sin nombre"}</div>
            </div>

            <div class="box">
              <span class="label">Correo</span>
              <div class="value">${order?.buyer_email || "-"}</div>
            </div>

            <div class="box">
              <span class="label">Ticket code</span>
              <div class="value">${ticket.ticket_code}</div>
            </div>

            <div class="box">
              <span class="label">Estado</span>
              <div class="value">${statusText}</div>
            </div>
          </div>

          <div class="status">${statusText}</div>
        </div>

        <div class="right">
          <div class="qr">
            <img src="${qrImageUrl}" alt="QR del boleto" />
          </div>
          <div class="ticket-code">${ticket.ticket_code}</div>
          <div class="small">
            Este código QR corresponde a un solo acceso.<br/>
            No compartas este boleto.
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});