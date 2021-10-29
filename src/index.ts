import 'reflect-metadata';
import Joi from 'joi';
import curry from 'just-curry-it';
import _mergeWith from 'lodash.mergewith';
import { arrayFrom, runAll, mergeArray, runOnce, skipFirstRun, isNotEmptyObject, assertIsDefined } from './utils';
import {
	HttpClientMetadataManager,
	InfoMetadataManager,
	MergeMetadataManager,
	MockMetadataManager,
	ParamMetadataManager,
	RequestMetadataManager,
} from './metadata';
import type {
	Validator,
	Transformer,
	HttpClient,
	GetSchema,
	HttpClientGetWithConfig,
	HttpClientGet,
	HttpClientGetWithUrlAndConfig,
} from './types';

const GlobalTarget = {};

const httpClientMetadataManager = new HttpClientMetadataManager({}, GlobalTarget);

const validate = (validators: Validator[] | undefined, data: any, ...parameters: any[]) => {
	if (!validators) return data;

	arrayFrom(validators).forEach((validator: Validator) => {
		if (!Joi.isSchema(validator)) {
			if (typeof validator !== 'function') {
				console.warn('Invalid Validator Type. The type must be Joi schema or function');
				return;
			}
			const { error } = validator(data, ...parameters) || {};
			if (!error) return;
			throw error;
		}
		const { error } = validator.validate(data);
		if (!error) return;
		throw error;
	});

	return data;
};

const transform = (transformers: Transformer[] | undefined, data: any, ...parameters: any[]) => {
	if (!transformers) return data;

	return arrayFrom(transformers).reduce((res, transformer) => {
		if (typeof transformer !== 'function') {
			console.warn('The transformer must be a function');
			return;
		}

		try {
			return transformer(res, ...parameters);
		} catch (e) {
			console.warn('Transform failed. Try to add a validator to solve this. ');
			console.warn(e);
			return res;
		}
	}, data);
};

function useHttpClient(httpClient: HttpClient, signature?: string) {
	httpClientMetadataManager.replace({
		httpClient,
		signature: signature || 'position',
	});
}

function Get({ request: { url, params, headers }, response }: GetSchema) {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const innerMethod = descriptor.value;

		const infoMetadataManager = new InfoMetadataManager({ _resolveTimes: 0 }, target, propertyKey);

		const requestMetadataManager = new RequestMetadataManager({}, target, propertyKey);
		_mergeWith(
			requestMetadataManager.get(),
			{
				get: [{ url, params, headers }],
			},
			mergeArray
		);

		const paramsMetadataManager = new ParamMetadataManager({}, target, propertyKey);
		const mergeMetadataManager = new MergeMetadataManager(undefined, target, propertyKey);
		const mockMetadataManager = new MockMetadataManager({}, target);

		const { validators, transformers, beforeValidate, afterValidate, beforeTransform, afterTransform, catcher } =
			response || {};

		const validatorList = validators && arrayFrom(validators);
		const transformerList = transformers && arrayFrom(transformers);
		const beforeValidateList = beforeValidate && arrayFrom(beforeValidate);
		const afterValidateList = afterValidate && arrayFrom(afterValidate);
		const beforeTransformList = beforeTransform && arrayFrom(beforeTransform);
		const afterTransformList = afterTransform && arrayFrom(afterTransform);

		descriptor.value = function (this: any, ...parameters: any[]) {
			const requestMetadata = requestMetadataManager.get();
			const httpClientMetadata = httpClientMetadataManager.get();
			const paramsMetaData = paramsMetadataManager.get();
			const merge = mergeMetadataManager.get();
			const mockMetadata = mockMetadataManager.get();

			isNotEmptyObject(requestMetadata, 'request metadata can not be empty');
			isNotEmptyObject(
				httpClientMetadata,
				'No Http Client! Maybe forgot to call useHttpClient before using this'
			);

			const requestCounts = requestMetadata.get.length;

			const innerP = Promise.resolve(innerMethod.call(this, ...parameters));

			const { httpClient, signature } = httpClientMetadata;

			const reqParams =
				params &&
				Object.keys(params).reduce((res: { [index: string]: any }, k) => {
					const { index, cb } = paramsMetaData[params[k]] || {};
					res[k] =
						typeof params[k] === 'symbol' ? (cb ? cb(parameters[index]) : parameters[index]) : params[k];
					return res;
				}, {});

			let resp;
			const resMockData = (mockMetadata as any)[propertyKey];

			if (resMockData) resp = Promise.resolve(resMockData.find(({ url: u }: { url: string }) => u === url));
			else {
				switch (signature) {
					case 'name':
						resp = (httpClient.get as HttpClientGetWithConfig)({
							url,
							params: reqParams,
							headers,
						});
						break;
					case 'position':
						resp = (httpClient.get as HttpClientGet)(url, reqParams, headers);
						break;
					case 'mix':
						resp = (httpClient.get as HttpClientGetWithUrlAndConfig)(url, {
							params: reqParams,
							headers,
						});
						break;
					default:
						break;
				}
			}

			assertIsDefined(resp);

			let responseData: unknown;
			let p = resp
				.then((res: any) => (responseData = res))
				.then(() => {
					if (beforeValidateList) {
						runAll(beforeValidateList, responseData);
					}
				})
				.then(() => {
					validate(validatorList, responseData, ...parameters);
				})
				.then(() => {
					if (afterValidateList) {
						runAll(afterValidateList, responseData);
					}
				})
				.then(() => {
					if (beforeTransformList) {
						return beforeTransformList.reduce((res, cur) => cur(res), responseData);
					}
				})
				.then((res: any) => transform(transformerList, res || responseData, ...parameters))
				.then((transformedData: any) => {
					if (afterTransformList) {
						runAll(afterTransformList, transformedData);
					}
					return transformedData;
				});

			if (catcher) p = p.catch(catcher);
			if (!merge && requestCounts >= 2) {
				runOnce(() => {
					console.warn(
						'Use merge decorator to merge multiple request responses, otherwise outer request response would cover the inner request response as the final result.'
					);
				});
			}

			if (!merge) {
				return innerP.then(() => {
					infoMetadataManager.set((info) => {
						info._resolveTimes += 1;
					});
					return p;
				});
			}

			return innerP.then((innerValue) => {
				infoMetadataManager.set((info) => {
					info._resolveTimes += 1;
				});
				const next = merge(innerValue);
				mergeMetadataManager.replace(next);
				return p.then((res: any) =>
					infoMetadataManager.get()._resolveTimes >= requestCounts ? next(res) : res
				);
			});
		};
	};
}

function Params(key: string, cb?: (param: any) => any) {
	return function (target: any, propertyKey: string, parameterIndex: number) {
		if (key) {
			const paramsMetadataManager = new ParamMetadataManager({}, target, propertyKey);
			paramsMetadataManager.set((paramsMetadata) => {
				paramsMetadata[Symbol.for(key)] = {
					index: parameterIndex,
					cb,
				};
			});
		}
	};
}

function Mock(mockData: { [index: string]: any }) {
	return function (target: any, propertyKey: string) {
		if (process.env.NODE_ENV !== 'development') return;

		const mockMetadataManager = new MockMetadataManager({}, target);

		const returnMockData = (method: string) => {
			const requestMetadataManager = new RequestMetadataManager({}, target, method);
			const requestMetadata = requestMetadataManager.get();

			isNotEmptyObject(requestMetadata);

			return requestMetadata.get
				.map(({ url }: { url: string }) => {
					if (!mockData[url]) {
						console.warn(`Can not find mock data for ${url}`);
						return null;
					}
					return {
						url,
						mockData: mockData[url],
					};
				})
				.filter((d: object | null) => d);
		};

		if (!propertyKey) {
			const NATIVE_PROPS = ['length', 'name', 'arguments', 'caller', 'prototype'];
			Object.getOwnPropertyNames(target).forEach((prop) => {
				if (NATIVE_PROPS.includes(prop)) return;

				mockMetadataManager.set((mockMetadata) => {
					(mockMetadata as any)[prop] = returnMockData(prop);
				});
			});
		} else {
			mockMetadataManager.set((mockMetadata) => {
				(mockMetadata as any)[propertyKey] = returnMockData(propertyKey);
			});
		}
	};
}

function Merge(merge: (...args: any[]) => any) {
	return function (target: any, propertyKey: string) {
		const mergeMetadataManager = new MergeMetadataManager(undefined, target, propertyKey);
		mergeMetadataManager.replace(skipFirstRun(curry(merge)));
	};
}

function Sequence(targer: any, propertyKey: string) {
	
}

export { useHttpClient, Get, Params, Mock, Merge };
