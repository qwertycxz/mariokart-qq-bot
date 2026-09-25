import { type ChatScope, QQBot, type SendMessageOptions } from '@tencent-connect/qqbot-nodejs'
import { format } from 'util'
import { z } from 'zod'
import ASSIGN_MARKDOWN from './assign.md' with { type: 'text' }
import CHARACTERS_JSON from './characters.json' with { type: 'json' }
import REASSIGN_MARKDOWN from './reassign.md' with { type: 'text' }
import TEAM_MARKDOWN from './team.md' with { type: 'text' }
import VEHICLES_JSON from './vehicles.json' with { type: 'json' }

const INITIAL_REASSIGN = 3
const REASSIGN_COST = [15, 10, 5, 3]
const TEAM_NAMES = ['红', '蓝', '黄', '绿']
const VOTE_TIME = 60000

function logTimestamp(...data: unknown[]) {
	console.log(`[${new Date().toISOString()}]`, ...data)
}

function shuffleEntities(...candidate_pool: typeof CHARACTERS_JSON & typeof VEHICLES_JSON) {
	for (let i = candidate_pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[candidate_pool[i], candidate_pool[j]] = [candidate_pool[j], candidate_pool[i]]
	}
	return candidate_pool
}

interface TeamData {
	character: (typeof CHARACTERS_JSON)[number]
	cost: number
	credit: number
	index: number
	members: Record<string, Set<number>>
	reassign: number
	vehicle: (typeof VEHICLES_JSON)[number]
}

let current_state: 'IDLE' | 'ASSIGNING' = 'IDLE'
let event_id = ''
let message_id = ''
let event_time = new Date(0)
let message_time = new Date()
let character_pool = CHARACTERS_JSON.slice(TEAM_NAMES.length)
let vehicle_pool = VEHICLES_JSON.slice(TEAM_NAMES.length)
let vote_timeout: NodeJS.Timeout | undefined

const TEAM_DATA: TeamData[] = TEAM_NAMES.map((_, i) => ({
	character: CHARACTERS_JSON[i],
	cost: 0,
	credit: 0,
	index: i,
	members: {},
	reassign: 0,
	vehicle: VEHICLES_JSON[i],
}))

const QQ_BOT = new QQBot({
	...z
		.object({
			appId: z.string(),
			appSecret: z.string(),
		})
		.parse(process.env),
	markdownSupport: true,
})

async function handleAssign(scope: ChatScope, target: string, teams: TeamData[], message = '') {
	for (const team of TEAM_DATA) {
		for (const member of Object.values(team.members)) {
			member.clear()
		}
	}

	const send: SendMessageOptions = {
		target: {
			scope,
			targetId: target,
		},
	}

	if (event_time < message_time) {
		send.target.msgId = message_id
	} else {
		send.extra = {
			event_id,
		}
	}

	if (teams.length) {
		character_pool = shuffleEntities(...teams.map(({ character }) => character), ...character_pool)
		for (const team of teams) {
			const character = character_pool.pop()
			if (!character) return
			team.character = character
		}

		vehicle_pool = shuffleEntities(...teams.map(({ vehicle }) => vehicle), ...vehicle_pool)
		for (const team of teams) {
			const vehicle = vehicle_pool.pop()
			if (!vehicle) return
			team.vehicle = vehicle
		}

		let last = -1
		let rank = 0

		const sorted = TEAM_DATA.toSorted((a, b) => b.credit - a.credit)
		for (const [i, team] of sorted.entries()) {
			if (team.credit != last) {
				last = team.credit
				rank = i
			}
			team.cost = REASSIGN_COST[rank]

			if (team.reassign > 0 && team.cost <= team.credit) {
				send.keyboard = {
					content: {
						rows: [
							{
								buttons: TEAM_NAMES.map(name => ({
									action: {
										data: name,
										modal: {
											content: `重抽${name}队吗？投票不可撤销！`,
										},
										permission: {
											type: 2,
										},
										type: 1,
									},
									id: name,
									render_data: {
										label: `☐ ${name}队`,
										style: 0,
										visited_label: `☑ ${name}队`,
									},
								})),
							},
						],
					},
				}
			}
		}

		if (send.keyboard) {
			vote_timeout = setTimeout(() => {
				const reassign = new BigUint64Array(TEAM_DATA.length)
				let log = ''
				for (const team of TEAM_DATA) {
					if (!team.reassign) continue
					const approvals = new BigUint64Array(TEAM_DATA.length)
					const votes = Object.values(team.members)
					for (const vote of votes) {
						for (const index of vote) {
							approvals[index]++
						}
					}

					const amount = approvals.filter(approval => approval * 2n > votes.length).length
					if (amount <= team.reassign && amount * team.cost <= team.credit) {
						for (let i = 0; i < TEAM_DATA.length; i++) {
							if (approvals[i] * 2n > votes.length) {
								log = `${log}* ${TEAM_NAMES[team.index]}队重抽${TEAM_NAMES[i]}队\n`
								reassign[i]++
							}
						}
						team.credit -= amount * team.cost
						team.reassign -= amount
						continue
					}

					log = `${log}* ${TEAM_NAMES[team.index]}队一次重抽${amount}队，重抽次数惩罚归零\n`
					team.reassign = 0
				}

				return handleAssign(
					scope,
					target,
					TEAM_DATA.filter((_, i) => reassign[i]),
					log,
				)
			}, VOTE_TIME)
		}
	}

	send.markdown = {
		content: TEAM_DATA.map(({ character, credit, reassign, vehicle }, i) =>
			format(ASSIGN_MARKDOWN, TEAM_NAMES[i], reassign, credit, character.chinese, vehicle.chinese, character.weight, character.height, character.url, vehicle.weight, vehicle.height, vehicle.url),
		).join('\n'),
	}

	if (message) {
		send.markdown.content = format(REASSIGN_MARKDOWN, message, send.markdown.content)
	}

	try {
		await QQ_BOT.send(send)
	} catch {
		clearTimeout(vote_timeout)
		current_state = 'IDLE'
	}

	if (!send.keyboard) {
		current_state = 'IDLE'
	}
}

QQ_BOT.on(
	'interaction',
	(
		_,
		{
			data: {
				resolved: { button_data },
			},
			group_member_openid,
			id,
		},
	) => {
		event_id = id
		event_time = new Date()

		if (group_member_openid && button_data && TEAM_NAMES.includes(button_data)) {
			logTimestamp(`${group_member_openid}：${button_data}`)
			for (const { members } of TEAM_DATA) {
				if (group_member_openid in members) {
					members[group_member_openid].add(TEAM_NAMES.indexOf(button_data))
					break
				}
			}
		}
		return QQ_BOT.acknowledgeInteraction(id)
	},
)

const COMMAND_REGEX = /^\s*\/(.+?)\s*$/v
const SPACE_REGEX = /\s+/v

const CREDIT_SCHEMA = z.array(z.coerce.number().int())
const OWNER_SCHEMA = z.object({
	member_role: z.literal('owner'),
})

QQ_BOT.on('message', async (_, { content, mentions, raw: { author }, replyTarget }) => {
	if (replyTarget.msgId) {
		message_id = replyTarget.msgId
		message_time = new Date()
	}

	OWNER_SCHEMA.parse(author)
	const command = COMMAND_REGEX.exec(content)?.[1].split(SPACE_REGEX)
	if (!command) return

	const i = TEAM_NAMES.indexOf(command[0])
	if (i == -1) {
		switch (command[0]) {
			case '抽':
				if (current_state == 'ASSIGNING') return
				current_state = 'ASSIGNING'

				for (const team of TEAM_DATA) {
					team.reassign = INITIAL_REASSIGN
				}
				return handleAssign(replyTarget.scope, replyTarget.targetId, TEAM_DATA)
			case '分':
				try {
					for (const [j, credit] of CREDIT_SCHEMA.parse(command.slice(1)).entries()) {
						TEAM_DATA[j].credit += credit
					}
				} finally {
					await QQ_BOT.sendMarkdown(replyTarget, TEAM_DATA.map(({ credit }, j) => `${TEAM_NAMES[j]}队：${credit}`).join('\n'))
				}
		}
		return
	}

	if (mentions) {
		for (const { member_openid } of mentions) {
			if (!member_openid) continue
			if (TEAM_DATA[i].members[member_openid]) {
				delete TEAM_DATA[i].members[member_openid]
				continue
			}

			for (const { members } of TEAM_DATA) {
				delete members[member_openid]
			}
			TEAM_DATA[i].members[member_openid] = new Set()
		}
	}

	logTimestamp(`${command[0]}：${Object.keys(TEAM_DATA[i].members)}`)
	await QQ_BOT.sendMarkdown(
		replyTarget,
		`${command[0]}队：${Object.keys(TEAM_DATA[i].members)
			.map(id => format(TEAM_MARKDOWN, id))
			.join('')}`,
	)
})

await QQ_BOT.start()
