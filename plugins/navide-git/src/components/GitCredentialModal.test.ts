// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import GitCredentialModal from './GitCredentialModal.vue'

describe('GitCredentialModal', () => {
  it('saves and binds the entered credential before submitting askpass', async () => {
    const accounts = ref<Array<{ id: string; label: string; host: string; username: string; tokenLast4: string }>>([])
    const addAccount = vi.fn(async (input) => {
      accounts.value = [{
        id: 'account-1', label: input.label, host: input.host, username: input.username, tokenLast4: 'oken',
      }]
      return true
    })
    const bind = vi.fn(async () => true)
    const wrapper = mount(GitCredentialModal, {
      attachTo: document.body,
      props: {
        show: true,
        prompt: {
          host: 'github.com',
          usernameRequestId: null,
          passwordRequestId: 'password-request',
          username: 'octocat',
          password: 'token',
        },
        accountPort: {
          accounts,
          available: ref(true),
          refresh: vi.fn(async () => undefined),
          addAccount,
          bind,
        },
      },
      global: { plugins: [i18n], stubs: { Teleport: true } },
    })

    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.get('input[type="text"]').setValue('Work GitHub')
    await wrapper.get('[data-submit-credential]').trigger('click')

    expect(addAccount).toHaveBeenCalledWith({
      label: 'Work GitHub', host: 'github.com', username: 'octocat', token: 'token',
    })
    expect(bind).toHaveBeenCalledWith('account-1')
    expect(wrapper.emitted('submit')).toHaveLength(1)
    wrapper.unmount()
  })
})
