// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToggleSwitch from '../ToggleSwitch.vue'

// The switch is controlled: it never flips itself, it only emits the inverted
// value. Clicking or pressing Space/Enter on the <button role="switch"> emits
// update:modelValue with !modelValue; a disabled switch emits nothing;
// aria-checked always mirrors the current modelValue.

describe('ToggleSwitch', () => {
  it('emits update:modelValue with the inverted value on click', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('inverts from true to false', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: true } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('emits on Enter key (native button activation)', async () => {
    // A native <button> fires a click on Enter/Space; @vue/test-utils models
    // that by triggering the click event directly.
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false } })
    await wrapper.get('button').trigger('keydown.enter')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('does not emit when disabled', async () => {
    const wrapper = mount(ToggleSwitch, {
      props: { modelValue: false, disabled: true }
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('reflects modelValue in aria-checked', () => {
    const off = mount(ToggleSwitch, { props: { modelValue: false } })
    expect(off.get('button').attributes('aria-checked')).toBe('false')
    const on = mount(ToggleSwitch, { props: { modelValue: true } })
    expect(on.get('button').attributes('aria-checked')).toBe('true')
  })
})
