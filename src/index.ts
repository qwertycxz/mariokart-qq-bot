import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { literal, object, string } from 'zod'

const owner_schema = object({
	member_role: literal('owner'),
})

const qq_bot = new QQBot({
	...object({
		appId: string(),
		appSecret: string(),
	}).parse(process.env),
	markdownSupport: true,
})

qq_bot.on('message', (_, { content, raw: { author }, replyTarget }) => {
	owner_schema.parse(author)
	void qq_bot.sendMarkdown(replyTarget, content)
})

await qq_bot.start()
