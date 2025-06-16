/**
 * 等时圈计算和绘制的核心逻辑
 */

class IsochroneManager {
    constructor(map) {
        this.map = map;
        this.facilitiesLayer = null;
        this.isochronesLayer = null;
        this.allIsochrones = []; // 用于存储所有等时圈的边界
        this.allMarkers = []; // 用于存储所有标记
        this.allBounds = []; // 用于存储所有边界
        this.angles = 36; // 等时圈计算的角度数量，每10度一个方向
        this.colors = ['#FF5733', '#33FF57', '#3357FF', '#F1C40F', '#9B59B6', '#1ABC9C', '#E74C3C', '#3498DB', '#2ECC71', '#F39C12'];
        this.colorIndex = 0;
        
        // 请求控制参数
        this.maxRetries = 3; // 最大重试次数
        this.retryDelay = 1000; // 重试延迟时间（毫秒）
        this.maxRequestsPerSecond = 5; // 每秒最大请求数
        this.requestQueue = []; // 请求队列
        
        // 控制标志
        this.isCancelled = false; // 中止标志
        
        // 当前等时圈相关
        this.currentPolygon = null;
        this.marker = null;
        this.points = [];
    }



    /**
     * 清除当前地图上的等时圈和标记
     */
    clearCurrentIsochrone() {
        if (this.currentPolygon) {
            this.map.remove(this.currentPolygon);
        }
        if (this.marker) {
            this.map.remove(this.marker);
        }
        this.points = [];
        // 清除批量等时圈和标记
        this.clearAllIsochrones();
    }

    /**
     * 清除所有等时圈和标记
     */
    clearAllIsochrones() {
        if (this.allIsochrones) {
            this.allIsochrones.forEach(layer => {
                this.map.removeLayer(layer);
            });
            this.allIsochrones = [];
        }
        if (this.allMarkers) {
            this.allMarkers.forEach(marker => {
                this.map.removeLayer(marker);
            });
            this.allMarkers = [];
        }
        this.allBounds = [];
    }

    /**
     * 添加设施点标记
     * @param {Array} position [经度, 纬度]
     */
    addFacilityMarker(position) {
        this.marker = new AMap.Marker({
            position: position,
            map: this.map,
            // 使用默认标记样式
            icon: new AMap.Icon({
                // 使用高德地图内置的蓝色标记图标
                image: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
                size: new AMap.Size(25, 34),
                imageSize: new AMap.Size(25, 34)
            }),
            // 设置标记的锚点为图标的底部中心
            anchor: 'bottom-center'
        });
    }

    /**
     * 计算指定角度和距离的目标点坐标
     * @param {Array} start 起点坐标 [经度, 纬度]
     * @param {number} angle 角度（度）
     * @param {number} distance 距离（米）
     * @returns {Array} 目标点坐标 [经度, 纬度]
     */
    calculateDestination(start, angle, distance) {
        const R = 6371000; // 地球半径（米）
        const d = distance / R; // 角距离
        const lat1 = start[1] * Math.PI / 180;
        const lon1 = start[0] * Math.PI / 180;
        const brng = angle * Math.PI / 180;

        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) +
            Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
        const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
            Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

        return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
    }

    /**
     * 计算两点间的直线距离（Haversine公式）
     * @param {Array} point1 第一个点坐标 [经度, 纬度]
     * @param {Array} point2 第二个点坐标 [经度, 纬度]
     * @returns {number} 距离（米）
     */
    calculateDistance(point1, point2) {
        const R = 6371000; // 地球半径（米）
        const lat1 = point1[1] * Math.PI / 180;
        const lat2 = point2[1] * Math.PI / 180;
        const deltaLat = (point2[1] - point1[1]) * Math.PI / 180;
        const deltaLon = (point2[0] - point1[0]) * Math.PI / 180;

        const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c; // 返回距离（米）
    }

    /**
     * 使用路径规划服务计算到达时间
     * @param {Array} start 起点坐标
     * @param {Array} end 终点坐标（设施点）
     * @param {string} transport 交通方式
     * @returns {Promise} 返回行驶时间（秒）
     */
    /**
     * 延迟指定时间
     * @param {number} ms 延迟时间（毫秒）
     * @returns {Promise} 延迟Promise
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 限制请求速率的包装函数
     * @param {Function} fn 需要限制速率的函数
     * @returns {Promise} 函数执行结果
     */
    async rateLimit(fn) {
        // 检查队列中是否有过期的请求时间戳（1秒前的请求）
        const now = Date.now();
        this.requestQueue = this.requestQueue.filter(time => now - time < 1000);

        // 如果队列中的请求数达到限制，等待合适的时间
        if (this.requestQueue.length >= this.maxRequestsPerSecond) {
            const oldestRequest = this.requestQueue[0];
            const waitTime = Math.max(0, 1000 - (now - oldestRequest));
            await this.delay(waitTime);
        }

        // 添加新请求的时间戳
        this.requestQueue.push(Date.now());

        // 执行实际的函数
        return fn();
    }

    /**
     * 带重试机制的函数包装器
     * @param {Function} fn 需要重试的函数
     * @param {string} errorContext 错误上下文信息
     * @returns {Promise} 函数执行结果
     */
    async withRetry(fn, errorContext) {
        let lastError;
        for (let i = 0; i < this.maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (i < this.maxRetries - 1) {
                    await this.delay(this.retryDelay);
                }
            }
        }
        // 直接抛出原始错误，不添加额外的错误提示
        throw lastError;
    }

    async calculateTravelTime(start, end, transport) {
        const normalizedTransport = this.normalizeTransport(transport);

        // 使用 Web 服务 API 进行路径规划
        return this.withRetry(async () => {
            return await this.rateLimit(async () => {
                // 根据交通方式选择不同的 Web API URL
                let url;
                const origin = `${start[0]},${start[1]}`;
                const destination = `${end[0]},${end[1]}`;

                // 获取全局API密钥
                const apiKey = window.AKEY || AKEY;
                
                switch (normalizedTransport) {
                    case 'DRIVING':
                        url = `https://restapi.amap.com/v3/direction/driving?origin=${origin}&destination=${destination}&key=${apiKey}`;
                        break;
                    case 'WALKING':
                        url = `https://restapi.amap.com/v3/direction/walking?origin=${origin}&destination=${destination}&key=${apiKey}`;
                        break;
                    case 'BICYCLING':
                        // 使用 v4 版本骑行路径规划 API
                        url = `https://restapi.amap.com/v4/direction/bicycling?origin=${origin}&destination=${destination}&key=${apiKey}`;
                        break;
                    case 'BUS': // 用户可能输入 BUS
                    case 'TRANSIT': // 或者标准化的 TRANSIT
                        const cityCode = '0592'; // 示例：厦门市的citycode
                        url = `https://restapi.amap.com/v3/direction/transit/integrated?origin=${origin}&destination=${destination}&key=${apiKey}&city=${cityCode}`;
                        break;
                    default:
                        return Promise.reject(new Error('不支持的交通方式'));
                }

                console.log(`[IsochroneManager] Requesting URL: ${url}`);

                try {
                    const response = await fetch(url);
                    const data = await response.json();
                    console.log(`[IsochroneManager] Web API Response for ${transport} from ${start} to ${end}:`, data);

                    // 检查高德API返回状态是否成功 (status === '1')
                    if (data.status === '1') {
                        let travelTimeSeconds;
                        // 驾车、步行、公交模式的路径信息通常在 data.route (或 data.transit) 的 paths (或 segments) 中
                        if ((normalizedTransport === 'DRIVING' || normalizedTransport === 'WALKING') && data.route && data.route.paths && data.route.paths.length > 0) {
                            travelTimeSeconds = parseInt(data.route.paths[0].duration, 10);
                        } else if ((normalizedTransport === 'BUS' || normalizedTransport === 'TRANSIT') && data.route && data.route.transits && data.route.transits.length > 0) {
                            // 公交模式取第一个方案的总时间
                            travelTimeSeconds = parseInt(data.route.transits[0].duration, 10);
                        // 骑行模式的路径信息在高德V4 API中通常在 data.data.paths 中
                        } else if (normalizedTransport === 'BICYCLING') {
                            let pathData = null;
                            // 高德骑行 v4 API 返回结构通常是 data.data.paths
                            if (data.data && data.data.paths && data.data.paths.length > 0) {
                                pathData = data.data.paths[0];
                            } else if (data.paths && data.paths.length > 0) { // 兼容可能的 data.paths 结构
                                pathData = data.paths[0];
                            }

                            if (pathData && pathData.duration) {
                                travelTimeSeconds = parseInt(pathData.duration, 10);
                            } else {
                                // 如果骑行路径规划未能获取到时间，记录详细的API返回信息
                                const errorDetail = data.info || (data.data && data.data.info) || '骑行路径规划未能获取到时间，且无详细错误信息';
                                console.error(`骑行路径规划失败: ${errorDetail}`, data);
                                return Promise.reject(new Error(`骑行路径规划失败: ${errorDetail}`));
                            }
                        } else {
                            // 如果API返回status '1' 但路径数据结构不符合预期，也视为错误
                            const errorDetail = data.info || 'API成功响应但未找到有效路径数据';
                            console.error(`路径规划数据结构错误: ${errorDetail}`, data);
                            return Promise.reject(new Error(`路径规划数据结构错误: ${errorDetail}`));
                        }

                        if (isNaN(travelTimeSeconds)) {
                            console.error('路径规划返回的通行时间无效 (NaN)', data);
                            return Promise.reject(new Error('路径规划返回的通行时间无效'));
                        }
                        return travelTimeSeconds;
                    } else {
                        // API返回status不为'1'，表示请求失败
                        const errorInfo = data.infocode ? `错误码: ${data.infocode}, 信息: ${data.info}` : (data.info || '高德API返回未知错误');
                        console.error(`路径规划API请求失败: ${errorInfo}`, data);
                        return Promise.reject(new Error(`路径规划API请求失败: ${errorInfo}`));
                    }
                } catch (error) {
                    console.error(`[IsochroneManager] Web API request failed for ${transport}:`, error);
                    return Promise.reject(error);
                }
            });
        }, `计算从 ${start} 到 ${end}（${normalizedTransport}）的通行时间`);
    }

    /**
     * 获取交通方式的搜索配置
     * @param {string} transport 交通方式
     * @returns {Object} 搜索配置对象
     */
    getSearchConfig(transport) {
        const normalizedTransport = this.normalizeTransport(transport);
        const configs = {
            'DRIVING': { maxDistance: 50000, searchStep: 1000, name: '驾车' },
            'WALKING': { maxDistance: 10000, searchStep: 500, name: '步行' },
            'BICYCLING': { maxDistance: 20000, searchStep: 800, name: '骑行' },
            'BUS': { maxDistance: 30000, searchStep: 1000, name: '公交' },
            'TRANSIT': { maxDistance: 30000, searchStep: 1000, name: '公交' }
        };
        return configs[normalizedTransport] || configs['DRIVING'];
    }

    /**
     * 规范化交通方式参数
     * @param {string} transport 交通方式
     * @returns {string} 规范化后的交通方式
     */
    normalizeTransport(transport) {
        return typeof transport === 'string' ? transport.trim().toUpperCase() : 'DRIVING';
    }

    /**
     * 获取交通方式的最大搜索距离（向后兼容）
     * @param {string} transport 交通方式
     * @returns {number} 最大搜索距离（米）
     */
    getMaxSearchDistance(transport) {
        return this.getSearchConfig(transport).maxDistance;
    }

    /**
     * 添加请求延迟
     * @param {number} delay 延迟时间（毫秒）
     */
    async addDelay(delay = 500) {
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    /**
     * 更新进度显示
     * @param {number} current 当前进度
     * @param {number} total 总数
     * @param {string} status 状态信息
     */
    updateProgress(current, total, status = '') {
        if (typeof updateProgress === 'function') {
            const percentage = Math.round((current / total) * 100);
            updateProgress(percentage, status);
        }
    }

    /**
     * 获取等时圈颜色
     * @param {number} index 等时圈索引
     * @returns {string} 颜色值
     */
    getIsochroneColor(index) {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
        ];
        return colors[index % colors.length];
    }

    /**
     * 处理边界搜索错误
     * @param {Error} error 错误对象
     * @param {number} angle 角度
     * @param {string} transport 交通方式
     * @param {number} targetTime 目标时间
     */
    handleBoundarySearchError(error, angle, transport, targetTime) {
        const config = this.getSearchConfig(transport);
        
        if (error.message.includes('设置时间过低')) {
            console.warn(`角度 ${angle}：${config.name}模式下时间设置过低，跳过该方向`);
            return null; // 跳过该方向
        } else if (error.message.includes('计算已中止')) {
            throw error; // 重新抛出中止错误
        } else {
            console.warn(`角度 ${angle}：边界搜索失败:`, error.message);
            // 对于其他错误，使用默认距离生成点
            const defaultDistance = Math.min(1000, targetTime * 60 * 1.5); // 默认距离
            console.log(`角度 ${angle}：使用默认距离 ${defaultDistance.toFixed(0)}m`);
            return defaultDistance;
        }
    }

    /**
     * 应用中位数优化逻辑
     * @param {Array} boundaryData 边界点数据数组
     * @param {Array} facility 设施点坐标
     * @returns {Array} 优化后的边界点数组
     */
    applyMedianOptimization(boundaryData, facility) {
        if (boundaryData.length === 0) return [];
        
        // 获取所有边界点距离并排序
        let distances = boundaryData.map(data => data.distance).sort((a, b) => a - b);
        
        // 如果没有找到任何可达点（距离为0或极小值），假设500m处可达
        const minValidDistance = 500; // 最小有效距离
        distances = distances.map(dist => dist < minValidDistance ? minValidDistance : dist);
        
        // 去掉最低值后计算中位数
        if (distances.length > 1) {
            distances = distances.slice(1); // 移除最低值
        }
        
        // 计算中位数
        const medianDistance = distances.length % 2 === 0 
            ? (distances[distances.length / 2 - 1] + distances[distances.length / 2]) / 2
            : distances[Math.floor(distances.length / 2)];
        
        console.log(`去掉最低值后的距离范围：${Math.min(...distances).toFixed(0)}m - ${Math.max(...distances).toFixed(0)}m`);
        console.log(`边界点距离中位数：${medianDistance.toFixed(0)}m`);

        const optimizedPoints = [];
        for (let data of boundaryData) {
            // 如果距离小于最小有效距离，先调整为最小有效距离
            if (data.distance < minValidDistance) {
                data.distance = minValidDistance;
                data.point = this.calculateDestination(facility, data.angle, minValidDistance);
                console.log(`角度 ${data.angle}：距离过小，调整为最小有效距离 ${minValidDistance}m`);
            }
            
            // 如果距离低于中位数，调整为中位数距离
            if (data.distance < medianDistance) {
                console.log(`角度 ${data.angle}：距离 ${data.distance.toFixed(0)}m 低于中位数，调整为中位数距离 ${medianDistance.toFixed(0)}m`);
                data.point = this.calculateDestination(facility, data.angle, medianDistance);
                data.distance = medianDistance;
            }
            optimizedPoints.push(data.point);
        }
        
        return optimizedPoints;
    }

    /**
     * 执行二分搜索来精确定位边界点
     * @param {Array} facility 设施点坐标
     * @param {number} angle 角度
     * @param {number} targetTime 目标时间（秒）
     * @param {string} transport 交通方式
     * @param {number} low 搜索下界
     * @param {number} high 搜索上界
     * @param {number} maxIterations 最大迭代次数
     * @returns {Promise<Array>} 返回最佳边界点
     */
    async binarySearchBoundary(facility, angle, targetTime, transport, low, high, maxIterations = 5) {
        let bestPoint = null;
        let closestTimeDiff = Infinity;
        
        for (let i = 0; i < maxIterations; i++) {
            if (this.isCancelled) throw new Error('计算已中止');
            if (high - low < 10) break; // 搜索范围过小则停止

            const midDistance = (low + high) / 2;
            const point = this.calculateDestination(facility, angle, midDistance);
            const result = await this.testPointReachability(point, facility, targetTime, transport, angle, midDistance);
            
            if (result.isReachable) {
                const timeDiff = Math.abs(result.time - targetTime);
                if (timeDiff < closestTimeDiff) {
                    closestTimeDiff = timeDiff;
                    bestPoint = point;
                }
                low = midDistance; // 继续向外搜索
                console.log(`角度 ${angle}：二分搜索距离 ${midDistance.toFixed(0)}m 可达，用时 ${result.time.toFixed(0)}s`);
            } else if (!result.isObstacle) {
                high = midDistance; // 超时，向内搜索
                console.log(`角度 ${angle}：二分搜索距离 ${midDistance.toFixed(0)}m 超时，用时 ${result.time ? result.time.toFixed(0) : 'N/A'}s`);
            } else {
                high = midDistance; // 失败则向内搜索
            }
        }
        
        return bestPoint;
    }

    /**
     * 测试点的可达性
     * @param {Array} point 测试点坐标
     * @param {Array} facility 设施点坐标
     * @param {number} targetTime 目标时间（秒）
     * @param {string} transport 交通方式
     * @param {number} angle 角度
     * @param {number} distance 距离
     * @returns {Promise<Object>} 返回测试结果
     */
    async testPointReachability(point, facility, targetTime, transport, angle, distance) {
        try {
            const time = await this.calculateTravelTime(point, facility, transport);
            const isReachable = time <= targetTime;
            console.log(`角度 ${angle}：距离 ${distance}m ${isReachable ? '可达' : '超时'}，用时 ${time}秒`);
            return { isReachable, isObstacle: false, time };
        } catch (error) {
            console.warn(`角度 ${angle}：距离 ${distance}m 路径规划失败:`, error);
            return { isReachable: false, isObstacle: true, error };
        }
    }

    /**
     * 在指定方向上搜索等时圈边界点（优化版：智能障碍检测和边界搜索）
     * @param {Array} facility 设施点坐标
     * @param {number} angle 角度
     * @param {number} targetTime 目标时间（秒）
     * @param {string} transport 交通方式
     * @returns {Promise<Array>} 返回边界点坐标
     */
    async searchBoundaryPoint(facility, angle, targetTime, transport) {
        const config = this.getSearchConfig(transport);
        
        let lastReachableDistance = 0;
        let lastReachablePoint = null;
        let firstUnreachableDistance = config.maxDistance;
        let hasFoundUnreachable = false;
        
        // 逐步搜索，记录所有可达和不可达的点
        for (let distance = config.searchStep; distance <= config.maxDistance; distance += config.searchStep) {
            if (this.isCancelled) throw new Error('计算已中止');

            const point = this.calculateDestination(facility, angle, distance);
            const searchResult = await this.testPointReachability(point, facility, targetTime, transport, angle, distance);
            
            if (searchResult.isReachable) {
                // 更新最后一个可达点
                lastReachableDistance = distance;
                lastReachablePoint = point;
            } else if (!searchResult.isObstacle) {
                // 第一次遇到真正的不可达点（非障碍）
                if (!hasFoundUnreachable) {
                    const nextDistance = distance + config.searchStep;
                    if (nextDistance <= config.maxDistance) {
                        const nextPoint = this.calculateDestination(facility, angle, nextDistance);
                        const nextResult = await this.testPointReachability(nextPoint, facility, targetTime, transport, angle, nextDistance);
                        
                        if (!nextResult.isReachable) {
                            // 下一个点也不可达，确认当前点为真正的边界
                            firstUnreachableDistance = distance;
                            hasFoundUnreachable = true;
                            console.log(`角度 ${angle}：确认距离 ${distance}m 为不可达边界`);
                            break;
                        } else {
                            // 下一个点可达，当前点为障碍，跳过
                            console.log(`角度 ${angle}：跳过障碍点距离 ${distance}m`);
                            continue;
                        }
                    } else {
                        // 已到达最大搜索距离
                        firstUnreachableDistance = distance;
                        hasFoundUnreachable = true;
                        break;
                    }
                } else {
                    // 已经找到边界，停止搜索
                    break;
                }
            }
            // 如果是障碍，跳过此点继续搜索
        }
        
        // 如果没有找到任何可达点，返回假设的可达点
        if (lastReachablePoint === null) {
            console.log(`角度 ${angle}：未找到任何可达点，假设500m处可达`);
            return this.calculateDestination(facility, angle, 500);
        }
        
        // 如果没有找到不可达点，说明在最大搜索范围内都可达
        if (!hasFoundUnreachable) {
            console.log(`角度 ${angle}：在最大搜索范围内都可达，使用最后可达点`);
            return lastReachablePoint;
        }
        
        // 根据新的逻辑进行边界点精细搜索
        let bestPoint = lastReachablePoint;
        let low = lastReachableDistance;
        let high = firstUnreachableDistance;

        // 检查在初始1000米时是否可达，如果不可达，则直接报错
        if (firstUnreachableDistance <= 1000 && lastReachablePoint === null) {
            console.warn(`角度 ${angle}：${config.name}模式下，初始1000米不可达，判定为时间设置过小`);
            console.log(`角度 ${angle}：在0m 和 1000m 之间进行二分搜索`);
            
            const bestPoint = await this.binarySearchBoundary(facility, angle, targetTime, transport, 0, 1000, 5);
            if (!bestPoint) {
                console.warn(`角度 ${angle}：${config.name}模式下，0-1000米二分搜索后仍未找到可达点`);
                throw new Error(`设置时间过低，${config.name}模式1000米内无法到达`);
            }
            console.log(`角度 ${angle}：0-1000m二分搜索完成`);
            return bestPoint;
        } else {
            // 在最后一个可达点和第一个不可达点之间进行二分搜索
            console.log(`角度 ${angle}：在距离 ${lastReachableDistance.toFixed(0)}m 和 ${firstUnreachableDistance.toFixed(0)}m 之间进行二分搜索`);
            
            const refinedPoint = await this.binarySearchBoundary(facility, angle, targetTime, transport, lastReachableDistance, firstUnreachableDistance, 2);
            const bestPoint = refinedPoint || lastReachablePoint;
            
            // 验证最终结果
            if (bestPoint === lastReachablePoint && (lastReachablePoint === null || lastReachableDistance < 100)) {
                console.warn(`角度 ${angle}：${config.name}模式下，二分搜索后仍未找到有效边界点，判定为时间设置过低`);
                throw new Error(`设置时间过低，${config.name}模式无法在指定时间内到达有效距离`);
            }
            
            console.log(`角度 ${angle}：最终边界点确定`);
            return bestPoint;
        }
    }

    /**
     * 生成等时圈（带中位数优化逻辑）
     * @param {Array} position 设施点坐标 [经度, 纬度]
     * @param {number} time 时间（分钟）
     * @param {string} transport 交通方式
     * @returns {Promise} 返回生成等时圈的Promise
     */
    async generateIsochrone(position, time, transport) {
        this.clearCurrentIsochrone();
        this.addFacilityMarker(position);

        const targetTime = time * 60; // 转换为秒
        const angleStep = 360 / this.angles;
        const boundaryData = []; // 存储边界点数据：{angle, point, distance}

        // 第一阶段：计算每个方向上的等时距离点
        console.log('开始计算各方向边界点...');
        for (let i = 0; i < this.angles; i++) {
            if (this.isCancelled) throw new Error('计算已中止'); // 检查中止状态
            const angle = i * angleStep;
            try {
                const boundaryPoint = await this.searchBoundaryPoint(position, angle, targetTime, transport);
                if (boundaryPoint) {
                    const distance = this.calculateDistance(position, boundaryPoint);
                    boundaryData.push({ angle, point: boundaryPoint, distance });
                    console.log(`角度 ${angle}：找到边界点，距离 ${distance.toFixed(0)}m`);
                }
            } catch (error) {
                const result = this.handleBoundarySearchError(error, angle, transport, targetTime);
                if (result === null) {
                    continue; // 跳过该方向
                } else if (typeof result === 'number') {
                    // 使用默认距离生成点
                    const defaultPoint = this.calculateDestination(position, angle, result);
                    boundaryData.push({ angle, point: defaultPoint, distance: result });
                }
                // 如果是中止错误，会在handleBoundarySearchError中重新抛出
            }
        }

        // 第二阶段：中位数优化逻辑
        if (boundaryData.length > 0) {
            // 应用中位数优化逻辑
            const optimizedPoints = this.applyMedianOptimization(boundaryData, position);
            this.points = optimizedPoints;

            console.log(`最终生成 ${this.points.length} 个边界点`);
        }

        // 绘制等时圈多边形
        if (this.points.length > 2) {
            this.currentPolygon = new AMap.Polygon({
                path: this.points,
                strokeColor: '#409EFF',
                strokeWeight: 2,
                strokeOpacity: 0.8,
                fillColor: '#409EFF',
                fillOpacity: 0.3,
                map: this.map
            });

            // 调整地图视野
            this.map.setFitView([this.currentPolygon]);
        }

        return Promise.resolve();
    }

    /**
     * 批量生成等时圈
     * @param {Array} facilityPoints 设施点坐标数组
     * @param {number} time 时间（分钟）
     * @param {string} transport 交通方式
     * @param {string} apiKey API密钥（兼容性参数）
     * @param {Function} progressCallback 进度回调函数
     * @returns {Promise} 返回生成等时圈的Promise
     */
    async generateIsochrones(facilityPoints, time, transport, apiKey, progressCallback) {
        // 清除之前的等时圈
        this.clearAllIsochrones();
        
        const total = facilityPoints.length;
        console.log(`开始批量生成 ${total} 个等时圈`);
        
        for (let i = 0; i < facilityPoints.length; i++) {

            const position = facilityPoints[i];
            console.log(`正在生成第 ${i + 1}/${total} 个等时圈，设施点：[${position[0]}, ${position[1]}]`);
            
            try {
                // 为每个设施点生成单独的等时圈
                await this.generateSingleIsochrone(position, time, transport, i);
                
                // 更新进度
                this.updateProgress(i + 1, total, `正在生成第 ${i + 1}/${total} 个等时圈...`);
                
                // 添加延迟以避免请求过于频繁
                if (i < facilityPoints.length - 1) {
                    await this.addDelay(500);
                }
            } catch (error) {
                console.error(`生成第 ${i + 1} 个等时圈失败:`, error);
                // 继续处理下一个点，不中断整个批量处理
            }
        }
        
        console.log(`批量生成完成，共生成 ${this.allIsochrones.length} 个等时圈`);
        return Promise.resolve();
    }

    /**
     * 生成单个等时圈（用于批量处理）
     * @param {Array} position 设施点坐标
     * @param {number} time 时间（分钟）
     * @param {string} transport 交通方式
     * @param {number} index 索引，用于区分不同的等时圈
     * @returns {Promise} 返回生成等时圈的Promise
     */
    async generateSingleIsochrone(position, time, transport, index) {
        // 添加设施点标记
        const marker = new AMap.Marker({
            position: position,
            icon: new AMap.Icon({
                size: new AMap.Size(25, 34),
                imageSize: new AMap.Size(25, 34), // 确保图标图像尺寸与图标尺寸一致
                image: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png'
            }),
            anchor: 'bottom-center', // 确保批量生成的标记锚点也为底部中心
            title: `设施点 ${index + 1}`,
            map: this.map
        });
        this.allMarkers.push(marker);

        const targetTime = time * 60; // 转换为秒
        const angleStep = 360 / this.angles;
        const boundaryData = []; // 存储边界点数据
        const points = []; // 当前等时圈的边界点

        // 计算每个方向上的等时距离点
        for (let i = 0; i < this.angles; i++) {
            if (this.isCancelled) throw new Error('计算已中止'); // 检查中止状态
            const angle = i * angleStep;
            const point = await this.searchBoundaryPoint(position, angle, targetTime, transport);
            if (point) {
                const distance = this.calculateDistance(position, point);
                boundaryData.push({ angle, point, distance });
            }
        }

        // 中位数优化逻辑
        if (boundaryData.length > 0) {
            // 获取所有边界点距离并排序
            let distances = boundaryData.map(data => data.distance).sort((a, b) => a - b);
            
            // 如果没有找到任何可达点（距离为0或极小值），假设500m处可达
            const minValidDistance = 500; // 最小有效距离
            distances = distances.map(dist => dist < minValidDistance ? minValidDistance : dist);
            
            // 去掉最低值后计算中位数
            if (distances.length > 1) {
                distances = distances.slice(1); // 移除最低值
            }
            
            // 计算中位数
            const medianDistance = distances.length % 2 === 0 
                ? (distances[distances.length / 2 - 1] + distances[distances.length / 2]) / 2
                : distances[Math.floor(distances.length / 2)];

            for (let data of boundaryData) {
                // 如果距离小于最小有效距离，先调整为最小有效距离
                if (data.distance < minValidDistance) {
                    data.distance = minValidDistance;
                    data.point = this.calculateDestination(position, data.angle, minValidDistance);
                }
                
                // 如果距离低于中位数，调整为中位数距离
                if (data.distance < medianDistance) {
                    data.point = this.calculateDestination(position, data.angle, medianDistance);
                    data.distance = medianDistance;
                }
                points.push(data.point);
            }
        }

        // 绘制等时圈多边形
        if (points.length > 2) {
            // 为每个等时圈使用不同的颜色
            const color = this.getIsochroneColor(index);
            
            const polygon = new AMap.Polygon({
                path: points,
                strokeColor: color,
                strokeWeight: 2,
                strokeOpacity: 0.8,
                fillColor: color,
                fillOpacity: 0.2,
                map: this.map
            });
            
            this.allIsochrones.push(polygon);
            
            // 计算边界用于后续调整视野
            const bounds = polygon.getBounds();
            if (bounds) {
                this.allBounds.push(bounds);
            }
        }

        return Promise.resolve();
    }

    /**
     * 调整地图视野以显示所有等时圈
     */
    fitViewToAllIsochrones() {
        if (this.allIsochrones.length > 0) {
            // 使用所有等时圈来调整视野
            this.map.setFitView(this.allIsochrones, false, [20, 20, 20, 20]);
        } else if (this.allMarkers.length > 0) {
            // 如果没有等时圈，至少显示所有标记
            this.map.setFitView(this.allMarkers, false, [50, 50, 50, 50]);
        }
    }
}