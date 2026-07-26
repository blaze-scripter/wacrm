import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import cronParser from 'cron-parser'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, executeAutomation } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import type { Automation, TimeBasedTriggerConfig } from '@/types'

/**
 * Drain due `automation_pending_executions` rows and trigger `time_based` automations.
 * Meant to be hit on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  let processedPending = 0
  let triggeredTimeBased = 0

  // 1. Drain automation_pending_executions
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (due && due.length > 0) {
    for (const row of due) {
      const { data: claim } = await admin
        .from('automation_pending_executions')
        .update({ status: 'running' })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()
      if (!claim) continue

      await resumePendingExecution({
        id: row.id as string,
        automation_id: row.automation_id as string,
        account_id: row.account_id as string,
        user_id: row.user_id as string,
        contact_id: (row.contact_id as string | null) ?? null,
        log_id: (row.log_id as string | null) ?? null,
        parent_step_id: (row.parent_step_id as string | null) ?? null,
        branch: (row.branch as 'yes' | 'no' | null) ?? null,
        next_step_position: row.next_step_position as number,
        context: (row.context as AutomationContext) ?? {},
      })
      processedPending++
    }
  }

  // 2. Trigger due time_based automations
  const { data: timeBasedAutomations, error: tbError } = await admin
    .from('automations')
    .select('*')
    .eq('is_active', true)
    .eq('trigger_type', 'time_based')

  if (tbError) {
    console.error('[cron] failed to fetch time_based automations:', tbError)
    return NextResponse.json({ processedPending, triggeredTimeBased, error: tbError.message }, { status: 500 })
  }

  if (timeBasedAutomations && timeBasedAutomations.length > 0) {
    for (const row of timeBasedAutomations) {
      const automation = row as Automation
      const config = (automation.trigger_config || {}) as TimeBasedTriggerConfig
      if (!config.schedule) continue

      try {
        const interval = cronParser.parse(config.schedule, {
          tz: config.timezone || 'UTC',
        })

        // Find the most recent time this cron SHOULD have run prior to right now.
        const prevRun = interval.prev().toDate()
        const lastExec = automation.last_executed_at ? new Date(automation.last_executed_at) : new Date(automation.created_at)

        // If the most recent expected run is STRICTLY AFTER the last time we executed it, it's due!
        if (prevRun.getTime() > lastExec.getTime()) {
          console.log(`[cron] Triggering time_based automation ${automation.id}`)
          
          // 1. Fetch contacts
          let contactsQuery = admin
            .from('contacts')
            .select('id')
            .eq('account_id', automation.account_id)

          if (config.target_tag_id) {
            // Need to join via contact_tags. Since Supabase PostgREST doesn't support 
            // inner join filtering on the root table cleanly for this, we do an 'in' query.
            const { data: tagged } = await admin
              .from('contact_tags')
              .select('contact_id')
              .eq('tag_id', config.target_tag_id)
            
            if (tagged && tagged.length > 0) {
              const contactIds = tagged.map(t => t.contact_id)
              contactsQuery = contactsQuery.in('id', contactIds)
            } else {
              // No contacts have this tag, skip execution but update timestamp
              await admin.from('automations').update({ last_executed_at: new Date().toISOString() }).eq('id', automation.id)
              continue
            }
          }

          const { data: contacts, error: contactsErr } = await contactsQuery
          
          if (contactsErr) {
            console.error(`[cron] failed to fetch contacts for automation ${automation.id}:`, contactsErr)
            continue
          }

          // 2. Queue executions via executeAutomation
          if (contacts && contacts.length > 0) {
            for (const contact of contacts) {
              await executeAutomation(automation, {
                accountId: automation.account_id,
                triggerType: 'time_based',
                contactId: contact.id,
                context: {},
              })
            }
          }

          // 3. Update last_executed_at so it doesn't trigger again until next cycle
          await admin
            .from('automations')
            .update({ last_executed_at: new Date().toISOString() })
            .eq('id', automation.id)

          triggeredTimeBased++
        }
      } catch (err) {
        console.error(`[cron] invalid cron schedule for automation ${automation.id}:`, err)
      }
    }
  }

  return NextResponse.json({ processedPending, triggeredTimeBased })
}
