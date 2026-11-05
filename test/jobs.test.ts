import { describe, expect, it } from 'vitest'

import {
  APIConnectionError,
  ConfigurationError,
  InsufficientCreditsError,
  JobTimeoutError,
  NotFoundError,
  PermissionDeniedError,
  ServerError,
  UnexpectedResponseError,
} from '../src/index.js'
import {
  accepted,
  FakeApi,
  fakeTime,
  IMAGE_PATH,
  job,
  JOB_ID,
  JOB_PATH,
  jsonResponse,
  makeClient,
  networkError,
  PNG,
  RUN_ID,
  succeeded,
} from './helpers.js'

const RUN = '/v1/modules/removeBgApi'

describe('long runs', () => {
  it('follows a long job', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, job('running'), succeeded())
    const result = await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(result.id).toBe(RUN_ID)
    expect(result.image).toEqual(PNG)
    expect(result.outputs[0]!.key).toBe('out')
    const followUps = api.calls('GET', JOB_PATH)
    expect(followUps).toHaveLength(2)
    expect(followUps[0]!.headers.get('prefer')).toBe('wait=25')
    expect(followUps[0]!.headers.get('x-api-key')).toBeTruthy()
    expect(followUps[0]!.url.host).toBe('api.pixlub.test')
  })

  it('raises the error of a failed job', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue(
      'GET',
      JOB_PATH,
      job('failed', { http_status: 402, error: 'not enough credits', code: 'insufficient_credits', required: 10 }),
    )
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(InsufficientCreditsError)
    expect(error).toMatchObject({ httpStatus: 402, code: 'insufficient_credits', requiredCredits: 10, jobId: JOB_ID })
    expect(error.message).toBe(`not enough credits (job ${JOB_ID}) (HTTP 402, code=insufficient_credits)`)
  })

  it.each([undefined, 200, 'x', 700])('makes a failed job with http_status %s a server error', async status => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, job('failed', { http_status: status ?? null, code: 'interrupted', error: 'stopped' }))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(ServerError)
    expect(error).toMatchObject({ code: 'interrupted', httpStatus: 500 })
  })

  it('makes an interrupted job a server error', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, job('failed', { http_status: 503, code: 'interrupted', error: 'interrupted' }))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(ServerError)
  })

  it('refuses an accepted run without a job id', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, jsonResponse({ status: 'running' }, 202))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG })).rejects.toThrow(UnexpectedResponseError)
  })

  it('refuses a job answer with an unknown status', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, job('exploded'))
    const error = await capture(makeClient(api).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(UnexpectedResponseError)
    expect(error).toMatchObject({ jobId: JOB_ID })
  })

  it('pauses between follow-ups the API answers at once', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, job('queued'), job('running'), succeeded())
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(fakeTime.waits).toEqual([2, 2])
  })

  it('does not pause after a long wait', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue(
      'GET',
      JOB_PATH,
      () => {
        fakeTime.now += 25
        return job('running')
      },
      succeeded(),
    )
    await makeClient(api).tools.run('removeBgApi', { image: PNG })
    expect(fakeTime.waits).toEqual([])
    expect(api.calls('GET', JOB_PATH)).toHaveLength(2)
  })

  it('stops following at the deadline', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, ...Array.from({ length: 10 }, () => job('running')))
    const error = await capture(makeClient(api, { jobTimeout: 5000 }).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(JobTimeoutError)
    expect(error).toBeInstanceOf(APIConnectionError)
    expect(error).toMatchObject({ jobId: JOB_ID, requestSent: true })
    expect(error.message).toContain(JOB_ID)
    expect(error.message).toContain('charged')
    expect(error.message).toContain('after 5 s')
    expect(api.calls('GET', JOB_PATH)).toHaveLength(3)
    expect(fakeTime.waits.reduce((a, b) => a + b, 0)).toBeCloseTo(5)
  })

  it('takes a per-call jobTimeout and waits less near the deadline', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, ...Array.from({ length: 10 }, () => job('running')))
    await expect(makeClient(api).tools.run('removeBgApi', { image: PNG, jobTimeout: 3000 })).rejects.toThrow(
      JobTimeoutError,
    )
    expect(api.calls('GET', JOB_PATH).map(r => r.headers.get('prefer'))).toEqual(['wait=3', 'wait=1'])
  })

  it.each([0, -1, '30', true, Number.POSITIVE_INFINITY])('refuses the jobTimeout %s of a call', async value => {
    const api = new FakeApi()
    await expect(
      makeClient(api).tools.run('removeBgApi', { image: PNG, jobTimeout: value as number }),
    ).rejects.toThrow(ConfigurationError)
    expect(api.calls('POST', RUN)).toEqual([])
  })

  it('names a lost job and warns of the charge', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, jsonResponse({ error: 'Unknown job', code: 'job_not_found' }, 404))
    const error = await capture(makeClient(api, { maxRetries: 0 }).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({ jobId: JOB_ID })
    expect(error.message).toContain(`GET /v1/jobs/${JOB_ID}`)
    expect(error.message).toContain('may have been charged')
  })

  it('names the job when a follow-up cannot connect', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, networkError('ECONNREFUSED', 'connect'), networkError('ECONNREFUSED', 'connect'))
    const error = await capture(makeClient(api, { maxRetries: 1 }).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(APIConnectionError)
    expect(error).toMatchObject({ jobId: JOB_ID })
    expect(error.message).toContain('may have been charged')
  })

  it('names the job when a download fails after it', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, accepted())
    api.queue('GET', JOB_PATH, succeeded())
    api.queue('GET', IMAGE_PATH, jsonResponse({ error: 'expired' }, 403))
    const error = await capture(makeClient(api, { maxRetries: 0 }).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(PermissionDeniedError)
    expect(error).toMatchObject({ jobId: JOB_ID })
    expect(error.message).toContain(JOB_ID)
  })

  it('says a direct run was charged when its download fails', async () => {
    const api = new FakeApi()
    api.queue('GET', IMAGE_PATH, jsonResponse({ error: 'gone' }, 404))
    const error = await capture(makeClient(api, { maxRetries: 0 }).tools.run('removeBgApi', { image: PNG }))
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.jobId).toBeUndefined()
    expect(error.message).toContain(`Run ${RUN_ID} succeeded and was charged`)
  })
})

describe('read floors', () => {
  /** Answers after `ms` of real time. */
  function slow(ms: number, answer: () => Response) {
    return () => new Promise<Response>(resolve => setTimeout(() => resolve(answer()), ms))
  }

  it('waits at least 70 s for a run and 35 s for a follow-up, whatever the timeout', async () => {
    const api = new FakeApi()
    api.queue('POST', RUN, slow(80, accepted))
    api.queue('GET', JOB_PATH, slow(80, () => job('running')), slow(80, succeeded))
    const result = await makeClient(api, { timeout: 20 }).tools.run('removeBgApi', { image: PNG })
    expect(result.image).toEqual(PNG)
  })

  it('keeps the plain timeout for other requests', async () => {
    const api = new FakeApi()
    api.queue('GET', '/v1/modules', slow(200, () => jsonResponse([])))
    await expect(makeClient(api, { timeout: 20, maxRetries: 0 }).tools.list()).rejects.toThrow(/did not answer in time/)
  })
})

async function capture(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise
  } catch (error) {
    return error as Error & Record<string, unknown>
  }
  throw new Error('expected a rejection')
}
