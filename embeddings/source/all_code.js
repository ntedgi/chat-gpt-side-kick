export * from './types.js'
export { default, default as rateLimit } from './lib.js'
export { default as MemoryStore } from './memory-store.js'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import MemoryStore from './memory-store.js'
import type {
	Options,
	AugmentedRequest,
	RateLimitRequestHandler,
	LegacyStore,
	Store,
	IncrementResponse,
	ValueDeterminingMiddleware,
	RateLimitExceededEventHandler,
	RateLimitReachedEventHandler,
} from './types.js'
const isLegacyStore = (store: LegacyStore | Store): store is LegacyStore =>
	typeof (store as any).incr === 'function' &&
	typeof (store as any).increment !== 'function'

const promisifyStore = (passedStore: LegacyStore | Store): Store => {
	if (!isLegacyStore(passedStore)) {
		return passedStore
	}

	const legacyStore = passedStore

	class PromisifiedStore implements Store {
		async increment(key: string): Promise<IncrementResponse> {
			return new Promise((resolve, reject) => {
				legacyStore.incr(
					key,
					(
						error: Error | undefined,
						totalHits: number,
						resetTime: Date | undefined,
					) => {
						if (error) reject(error)
						resolve({ totalHits, resetTime })
					},
				)
			})
		}

		async decrement(key: string): Promise<void> {
			return legacyStore.decrement(key)
		}

		async resetKey(key: string): Promise<void> {
			return legacyStore.resetKey(key)
		}

		async resetAll(): Promise<void> {
			if (typeof legacyStore.resetAll === 'function')
				return legacyStore.resetAll()
		}
	}

	return new PromisifiedStore()
}

type Configuration = {
	windowMs: number
	max: number | ValueDeterminingMiddleware<number>
	message: any | ValueDeterminingMiddleware<any>
	statusCode: number
	legacyHeaders: boolean
	standardHeaders: boolean
	requestPropertyName: string
	skipFailedRequests: boolean
	skipSuccessfulRequests: boolean
	keyGenerator: ValueDeterminingMiddleware<string>
	handler: RateLimitExceededEventHandler
	onLimitReached: RateLimitReachedEventHandler
	skip: ValueDeterminingMiddleware<boolean>
	requestWasSuccessful: ValueDeterminingMiddleware<boolean>
	store: Store
}


const parseOptions = (passedOptions: Partial<Options>): Configuration => {
	const notUndefinedOptions: Partial<Options> =
		omitUndefinedOptions(passedOptions)

	const config: Configuration = {
		windowMs: 60 * 1000,
		max: 5,
		message: 'Too many requests, please try again later.',
		statusCode: 429,
		legacyHeaders: passedOptions.headers ?? true,
		standardHeaders: passedOptions.draft_polli_ratelimit_headers ?? false,
		requestPropertyName: 'rateLimit',
		skipFailedRequests: false,
		skipSuccessfulRequests: false,
		requestWasSuccessful: (_request: Request, response: Response): boolean =>
			response.statusCode < 400,
		skip: (_request: Request, _response: Response): boolean => false,
		keyGenerator(request: Request, _response: Response): string {
			if (!request.ip) {
				console.error(
					'WARN | `express-rate-limit` | `request.ip` is undefined. You can avoid this by providing a custom `keyGenerator` function, but it may be indicative of a larger issue.',
				)
			}

			return request.ip
		},
		async handler(
			request: Request,
			response: Response,
			_next: NextFunction,
			_optionsUsed: Options,
		): Promise<void> {
			response.status(config.statusCode)
			const message: unknown =
				typeof config.message === 'function'
					? await (config.message as ValueDeterminingMiddleware<any>)(
							request,
							response,
					  )
					: config.message

			if (!response.writableEnded) {
				response.send(message ?? 'Too many requests, please try again later.')
			}
		},
		onLimitReached(
			_request: Request,
			_response: Response,
			_optionsUsed: Options,
		): void {},
		...notUndefinedOptions,
		store: promisifyStore(notUndefinedOptions.store ?? new MemoryStore()),
	}

	if (
		typeof config.store.increment !== 'function' ||
		typeof config.store.decrement !== 'function' ||
		typeof config.store.resetKey !== 'function' ||
		(typeof config.store.resetAll !== 'undefined' &&
			typeof config.store.resetAll !== 'function') ||
		(typeof config.store.init !== 'undefined' &&
			typeof config.store.init !== 'function')
	) {
		throw new TypeError(
			'An invalid store was passed. Please ensure that the store is a class that implements the `Store` interface.',
		)
	}

	return config
}


const handleAsyncErrors =
	(fn: RequestHandler): RequestHandler =>
	async (request: Request, response: Response, next: NextFunction) => {
		try {
			await Promise.resolve(fn(request, response, next)).catch(next)
		} catch (error: unknown) {
			next(error)
		}
	}

const rateLimit = (
	passedOptions?: Partial<Options>,
): RateLimitRequestHandler => {
	const options = parseOptions(passedOptions ?? {})
	if (typeof options.store.init === 'function') options.store.init(options)

	const middleware = handleAsyncErrors(
		async (request: Request, response: Response, next: NextFunction) => {
			const skip = await options.skip(request, response)
			if (skip) {
				next()
				return
			}

			const augmentedRequest = request as AugmentedRequest

			const key = await options.keyGenerator(request, response)
			const { totalHits, resetTime } = await options.store.increment(key)

			const retrieveQuota =
				typeof options.max === 'function'
					? options.max(request, response)
					: options.max

			const maxHits = await retrieveQuota
			augmentedRequest[options.requestPropertyName] = {
				limit: maxHits,
				current: totalHits,
				remaining: Math.max(maxHits - totalHits, 0),
				resetTime,
			}

			if (options.legacyHeaders && !response.headersSent) {
				response.setHeader('X-RateLimit-Limit', maxHits)
				response.setHeader(
					'X-RateLimit-Remaining',
					augmentedRequest[options.requestPropertyName].remaining,
				)

				if (resetTime instanceof Date) {
					response.setHeader('Date', new Date().toUTCString())
					response.setHeader(
						'X-RateLimit-Reset',
						Math.ceil(resetTime.getTime() / 1000),
					)
				}
			}

			if (options.standardHeaders && !response.headersSent) {
				response.setHeader('RateLimit-Limit', maxHits)
				response.setHeader(
					'RateLimit-Remaining',
					augmentedRequest[options.requestPropertyName].remaining,
				)

				if (resetTime) {
					const deltaSeconds = Math.ceil(
						(resetTime.getTime() - Date.now()) / 1000,
					)
					response.setHeader('RateLimit-Reset', Math.max(0, deltaSeconds))
				}
			}

			if (options.skipFailedRequests || options.skipSuccessfulRequests) {
				let decremented = false
				const decrementKey = async () => {
					if (!decremented) {
						await options.store.decrement(key)
						decremented = true
					}
				}

				if (options.skipFailedRequests) {
					response.on('finish', async () => {
						if (!options.requestWasSuccessful(request, response))
							await decrementKey()
					})
					response.on('close', async () => {
						if (!response.writableEnded) await decrementKey()
					})
					response.on('error', async () => {
						await decrementKey()
					})
				}

				if (options.skipSuccessfulRequests) {
					response.on('finish', async () => {
						if (options.requestWasSuccessful(request, response))
							await decrementKey()
					})
				}
			}

			if (maxHits && totalHits === maxHits + 1) {
				options.onLimitReached(request, response, options)
			}

			if (maxHits && totalHits > maxHits) {
				if (
					(options.legacyHeaders || options.standardHeaders) &&
					!response.headersSent
				) {
					response.setHeader('Retry-After', Math.ceil(options.windowMs / 1000))
				}

				options.handler(request, response, next, options)
				return
			}

			next()
		},
	)

	;(middleware as RateLimitRequestHandler).resetKey =
		options.store.resetKey.bind(options.store)

	return middleware as RateLimitRequestHandler
}

const omitUndefinedOptions = (
	passedOptions: Partial<Options>,
): Partial<Configuration> => {
	const omittedOptions: Partial<Configuration> = {}

	for (const k of Object.keys(passedOptions)) {
		const key = k as keyof Configuration

		if (passedOptions[key] !== undefined) {
			omittedOptions[key] = passedOptions[key]
		}
	}

	return omittedOptions
}

export default rateLimit

import type { Store, Options, IncrementResponse } from './types.js'


const calculateNextResetTime = (windowMs: number): Date => {
	const resetTime = new Date()
	resetTime.setMilliseconds(resetTime.getMilliseconds() + windowMs)
	return resetTime
}

export default class MemoryStore implements Store {
	
	windowMs!: number


	hits!: {
		[key: string]: number | undefined
	}

	resetTime!: Date

	interval?: NodeJS.Timer

	init(options: Options): void {
		this.windowMs = options.windowMs
		this.resetTime = calculateNextResetTime(this.windowMs)

		this.hits = {}

		this.interval = setInterval(async () => {
			await this.resetAll()
		}, this.windowMs)
		if (this.interval.unref) this.interval.unref()
	}

	async increment(key: string): Promise<IncrementResponse> {
		const totalHits = (this.hits[key] ?? 0) + 1
		this.hits[key] = totalHits

		return {
			totalHits,
			resetTime: this.resetTime,
		}
	}

	async decrement(key: string): Promise<void> {
		const current = this.hits[key]

		if (current) this.hits[key] = current - 1
	}

	async resetKey(key: string): Promise<void> {
		delete this.hits[key]
	}

	async resetAll(): Promise<void> {
		this.hits = {}
		this.resetTime = calculateNextResetTime(this.windowMs)
	}

	shutdown(): void {
		clearInterval(this.interval)
	}
}

import type { Request, Response, NextFunction, RequestHandler } from 'express'


export type IncrementCallback = (
	error: Error | undefined,
	totalHits: number,
	resetTime: Date | undefined,
) => void

export type ValueDeterminingMiddleware<T> = (
	request: Request,
	response: Response,
) => T | Promise<T>

export type RateLimitExceededEventHandler = (
	request: Request,
	response: Response,
	next: NextFunction,
	optionsUsed: Options,
) => void


export type RateLimitReachedEventHandler = (
	request: Request,
	response: Response,
	optionsUsed: Options,
) => void

export type IncrementResponse = {
	totalHits: number
	resetTime: Date | undefined
}

export type RateLimitRequestHandler = RequestHandler & {
	resetKey: (key: string) => void
}

export type LegacyStore = {

	incr: (key: string, callback: IncrementCallback) => void

	decrement: (key: string) => void

	resetKey: (key: string) => void

	resetAll?: () => void
}

export type Store = {
	init?: (options: Options) => void
	increment: (key: string) => Promise<IncrementResponse> | IncrementResponse
	decrement: (key: string) => Promise<void> | void

	resetKey: (key: string) => Promise<void> | void

	resetAll?: () => Promise<void> | void

	shutdown?: () => Promise<void> | void
}

export type Options = {
	readonly windowMs: number

	readonly max: number | ValueDeterminingMiddleware<number>

	readonly message: any | ValueDeterminingMiddleware<any>

	readonly statusCode: number

	readonly legacyHeaders: boolean

	readonly standardHeaders: boolean

	
	readonly requestPropertyName: string


	readonly skipFailedRequests: boolean


	readonly skipSuccessfulRequests: boolean

	
	readonly keyGenerator: ValueDeterminingMiddleware<string>


	readonly handler: RateLimitExceededEventHandler

	
	readonly onLimitReached: RateLimitReachedEventHandler


	readonly skip: ValueDeterminingMiddleware<boolean>


	readonly requestWasSuccessful: ValueDeterminingMiddleware<boolean>


	store: Store | LegacyStore


	headers?: boolean


	draft_polli_ratelimit_headers?: boolean
}
export type AugmentedRequest = Request & {
	[key: string]: RateLimitInfo
}
export type RateLimitInfo = {
	readonly limit: number
	readonly current: number
	readonly remaining: number
	readonly resetTime: Date | undefined
}
