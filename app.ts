import { Hono } from 'hono'
import { cors } from 'hono/cors' // Import CORS middleware
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from "./schema";
import {leads, waitlist} from "./schema";
import { eq, sql } from "drizzle-orm";

type Bindings = {
  CONNECTION_STRING: string;
  REFERRAL_LIMITER: RateLimit;
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

const B62_ALPHABET_ENCODE: string = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const B62_ALPHABET_DECODE = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// ENCODER FUNCTION
function encodeBase62(num: string) {
    let n = BigInt(num);
    if (n === 0n) return B62_ALPHABET_ENCODE[0];

    let result = "";
    const base = BigInt(62);

    while (n > 0n) {
        // Get the remainder (this is our character index)
        const remainder = n % base;
        result = B62_ALPHABET_ENCODE[Number(remainder)] + result;

        // Divide by 62 and truncate to move to the next "place"
        n = n / base;
    }
    return (result);
}

// DECODER FUNCTION
function decodeBase62BigInt(str: string) {
    let decimal = BigInt(0);
    const base = BigInt(62);

    for (const char of str) {
        const value = BigInt(B62_ALPHABET_DECODE.indexOf(char));
        decimal = decimal * base + value;
    }

    return decimal.toString(); // Returns as string to avoid precision loss elsewhere
}

app.use(async (c, next) => {
    const dbConnectionString = c.env.CONNECTION_STRING;
    const client = postgres(dbConnectionString, { prepare: false });
    const db = drizzle(client);

    const url = new URL(c.req.url)
    const ref: string = url.searchParams.get("ref")  || ""
    const { success } = await c.env.REFERRAL_LIMITER.limit({ key: ref})

    if (!success) {
        const decodeReferralSource: string = decodeBase62BigInt(ref);
        const referredId: number = Number(decodeReferralSource);

        const leadReferredSource = await db.select({
            id: leads.id,
            referredCount: leads.referredCount
        }).from(leads).where(eq(leads.id, referredId));
        const leadReferredId: number = leadReferredSource[0].id;


        return c.json({"message": "Too much requests, please try again later"}, 429)
    }

    await next()

});


// @ts-ignore
app.post('/', async (c) => {
  const dbConnectionString = c.env.CONNECTION_STRING;
  const client = postgres(dbConnectionString, { prepare: false });
  const db = drizzle(client);
  const queueRankings = db.$with('queueRankings').as(
      db.select({
        leadId: leads.id,
        referredCount: leads.referredCount,
        waitlistedAtTime: waitlist.waitlisted_at_time,
        queuePosition: sql<number>`ROW_NUMBER() OVER (ORDER BY ${leads.referredCount} DESC, ${waitlist.waitlisted_at_time} ASC)`.as('queue_position'),
      })
      .from(leads)
      .innerJoin(waitlist, eq(leads.id, waitlist.lead_id)))

  try {
    const body = await c.req.json();

    const requestData = body.request;

    if (requestData.request === "addToWaitlist") {

      if (requestData.ref == null || undefined) {
        const leadEmail: string = requestData.email;
        const newId: number = Math.floor(Math.random() * 1000000);

        await db.insert(leads).values({
          id: newId,
          email: leadEmail,
          referredCount: 0
        })

        const waitlistDate = new Date().toISOString().split('T')[0];

        await db.insert(waitlist).values({
          lead_id: newId,
          waitlisted_at: waitlistDate,
          waitlisted_at_time: new Date(),
          referred_by: null
        })

        const queuePosition = await db
            .select({
              leadId: leads.id,
              referredCount: leads.referredCount,
              waitlistedAtTime: waitlist.waitlisted_at_time,
              queuePosition: sql<number>`ROW_NUMBER() OVER (ORDER BY ${leads.referredCount} DESC, ${waitlist.waitlisted_at_time} ASC)`.as('queue_position'),
            })
            .from(leads)
            .innerJoin(waitlist, eq(leads.id, waitlist.lead_id));

        try {

          const encodeLeadId: string = encodeBase62(newId.toString());
          const referralLink = https://pov-orignal.vercel.app?ref=${encodeLeadId};

          const queuePosition = await db
              .with(queueRankings).select().from(queueRankings).where(eq(queueRankings.leadId, newId))

          return c.json({ success: true, message: Successfully added ${leadEmail}!, referralLink: referralLink, queueRank: queuePosition[0].queuePosition});

        } catch(error) {
          return error;
        }

      }

      if (requestData.ref) {
          const leadEmail: string = requestData.email;
          const ref: string = requestData.ref;
          const newId = Math.floor(Math.random() * 1000000);

          const decodeReferralSource: string = decodeBase62BigInt(ref);
          const referredId: number = Number(decodeReferralSource);

          const leadReferredSource = await db.select({
            id: leads.id,
            referredCount: leads.referredCount
          }).from(leads).where(eq(leads.id, referredId));

          const leadReferredId: number = leadReferredSource[0].id;
          const leadReferredCountNumber: number | null = leadReferredSource[0].referredCount;

          if (leadReferredId == undefined) {
            return c.json({message: "Referral source not found, please check the referral link"}, 404)
          }

          if (leadReferredCountNumber == undefined) {
              await db.insert(leads).values({
                  id: newId,
                  email: leadEmail,
                  referredCount: 0
              });
              await db.update(leads).set({
              referredCount: 1
            }).where(eq(leads.id, referredId))
          } else {
              await db.insert(leads).values({
                  id: newId,
                  email: leadEmail,
                  referredCount: 0
              });
              await db.update(leads).set({
                  referredCount: leadReferredCountNumber + 1
              }).where(eq(leads.id, referredId))
          }

          const waitlistDate = new Date().toISOString().split('T')[0];

          await db.insert(waitlist).values({
            lead_id: newId,
            waitlisted_at: waitlistDate,
            waitlisted_at_time: new Date(),
            referred_by: leadReferredId
          })

          const queuePosition = await db
              .with(queueRankings).select().from(queueRankings).where(eq(queueRankings.leadId, newId))

          const leadId: string = newId.toString();
          const encodeLeadId = encodeBase62(leadId)
          const referralLink = http://localhost:5173?ref=${encodeLeadId};

          return c.json({success: true, message:'Successfully added to waitlist! would you like to refer others as well?', referralLink: referralLink, queueRank: queuePosition[0].queuePosition})
        }
      }

    return c.json({ error: "Action not recognized" }, 400);

  } catch (error: any) {
    return c.json({ error }, 500);
  }

})

export default app;
