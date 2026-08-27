// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import PromptSkillPicker from '../PromptSkillPicker.vue'
import { RING_MAX_SLOTS, type PromptSkill } from '../../lib/promptSkills'

// The picker is a hover layer over the ∞ button: it must not open on a cursor
// merely crossing the header, must never swallow the plain click, and must
// fall back to the list layout when the ring would be too crowded.

function skill(id: string, over: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id,
    name: `skill ${id}`,
    icon: 'advance',
    description: `desc ${id}`,
    prompt: `prompt for ${id}`,
    resumePrompt: '',
    maxTurns: 0,
    category: 'dev',
    enabled: true,
    isDefault: false,
    ...over,
  }
}

let wrapper: VueWrapper | null = null

function makeWrapper(skills: PromptSkill[]): VueWrapper {
  return mount(PromptSkillPicker, {
    props: { skills },
    slots: { default: '<button class="loop-btn">∞</button>' },
    global: { mocks: { $t: (key: string) => key } },
    attachTo: document.body,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function menu(): HTMLElement | null {
  return document.body.querySelector('.ps-menu')
}

describe('PromptSkillPicker – hover intent', () => {
  it('stays closed while the cursor is only passing over the button', async () => {
    wrapper = makeWrapper([skill('a'), skill('b')])
    await wrapper.find('.ps-anchor').trigger('mouseenter')
    vi.advanceTimersByTime(200) // less than the open delay
    await wrapper.find('.ps-anchor').trigger('mouseleave')
    vi.advanceTimersByTime(1000)
    await wrapper.vm.$nextTick()
    expect(menu()).toBeNull()
  })

  it('opens after the hover delay and closes again after the leave grace', async () => {
    wrapper = makeWrapper([skill('a'), skill('b')])
    await wrapper.find('.ps-anchor').trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()
    expect(menu()).not.toBeNull()

    await wrapper.find('.ps-anchor').trigger('mouseleave')
    vi.advanceTimersByTime(100) // inside the grace window
    await wrapper.vm.$nextTick()
    expect(menu()).not.toBeNull()

    vi.advanceTimersByTime(200)
    await wrapper.vm.$nextTick()
    expect(menu()).toBeNull()
  })

  it('announces active as soon as the cursor lands, so the header can drop its own tooltip', async () => {
    wrapper = makeWrapper([skill('a')])
    await wrapper.find('.ps-anchor').trigger('mouseenter')
    expect(wrapper.emitted('active')?.[0]).toEqual([true])
    await wrapper.find('.ps-anchor').trigger('mouseleave')
    vi.advanceTimersByTime(300)
    expect(wrapper.emitted('active')?.at(-1)).toEqual([false])
  })

  it('never opens when there is nothing to cast', async () => {
    wrapper = makeWrapper([])
    await wrapper.find('.ps-anchor').trigger('mouseenter')
    vi.advanceTimersByTime(1000)
    await wrapper.vm.$nextTick()
    expect(menu()).toBeNull()
  })
})

describe('PromptSkillPicker – casting', () => {
  async function open(skills: PromptSkill[]): Promise<VueWrapper> {
    const w = makeWrapper(skills)
    await w.find('.ps-anchor').trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await w.vm.$nextTick()
    return w
  }

  it('emits the chosen skill id and closes', async () => {
    wrapper = await open([skill('a'), skill('b')])
    const slots = document.body.querySelectorAll<HTMLElement>('.ps-slot')
    expect(slots).toHaveLength(2)
    slots[1].click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cast')?.[0]).toEqual(['b'])
    expect(menu()).toBeNull()
  })

  it('leaves the wrapped button click untouched', async () => {
    wrapper = makeWrapper([skill('a')])
    // The picker wraps the button; clicking it must not be intercepted, so no
    // picker event fires and the host's own handler is free to run.
    await wrapper.find('.loop-btn').trigger('click')
    expect(wrapper.emitted('cast')).toBeUndefined()
  })

  it('previews the skill under the cursor', async () => {
    wrapper = await open([skill('a'), skill('b')])
    expect(document.body.querySelector('.ps-preview')).toBeNull()
    const slots = document.body.querySelectorAll<HTMLElement>('.ps-slot')
    slots[0].dispatchEvent(new MouseEvent('mouseenter'))
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.ps-preview')?.textContent).toContain('prompt for a')
  })

  it('closes on Escape without casting', async () => {
    wrapper = await open([skill('a')])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(menu()).toBeNull()
    expect(wrapper.emitted('cast')).toBeUndefined()
  })
})

describe('PromptSkillPicker – layout fallback', () => {
  it('uses the ring up to the slot cap', async () => {
    wrapper = makeWrapper(Array.from({ length: RING_MAX_SLOTS }, (_, i) => skill(`s${i}`)))
    await wrapper.find('.ps-anchor').trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()
    expect(menu()?.classList.contains('list')).toBe(false)
    expect(document.body.querySelectorAll('.ps-slot')).toHaveLength(RING_MAX_SLOTS)
  })

  it('switches to the list once there are more skills than the ring holds', async () => {
    wrapper = makeWrapper(Array.from({ length: RING_MAX_SLOTS + 1 }, (_, i) => skill(`s${i}`)))
    await wrapper.find('.ps-anchor').trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await wrapper.vm.$nextTick()
    expect(menu()?.classList.contains('list')).toBe(true)
    expect(document.body.querySelectorAll('.ps-row')).toHaveLength(RING_MAX_SLOTS + 1)
  })
})
